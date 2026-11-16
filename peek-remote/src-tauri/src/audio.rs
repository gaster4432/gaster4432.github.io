// Native desktop-audio setup.
//
// Linux: desktop audio is captured by loading a HIDDEN remap-source on the
// default sink's monitor — `module-remap-source master=<sink>.monitor
// source_name=peek_remote_desktop_audio`. It is a virtual input that carries
// exactly the desktop mix and nothing else; the frontend captures it with
// getUserMedia and forwards it as the audio track. Loading is idempotent,
// user-level (no root, no drivers), and we only unload what we loaded.
//
// Windows: the normal way is WASAPI loopback capture, the "hidden device"
// way is impossible without shipping a kernel driver — we don't. Honest
// stub for now: the frontend falls back to the browser-level display-audio
// path (best effort on WebView2), and if that yields nothing we share
// video-only with a chip saying exactly why.

use serde::Serialize;

#[cfg(target_os = "linux")]
use std::process::Command;
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "linux")]
const SOURCE_NAME: &str = "peek_remote_desktop_audio";
#[cfg(target_os = "linux")]
const SOURCE_DESC: &str = "Peek Remote Audio";

#[cfg(target_os = "linux")]
static LOADED_BY_US: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
pub struct AudioState {
  pub ok: bool,
  pub reason: String,
}

#[cfg(target_os = "linux")]
fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
  let out = Command::new(cmd).args(args).output()
    .map_err(|e| format!("{cmd}: {e}"))?;
  if !out.status.success() {
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    return Err(format!("{cmd} {} failed: {err}", args.join(" ")));
  }
  Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(target_os = "linux")]
fn setup() -> Result<String, String> {
  // Required: a Pulse/PipeWire server. On the Deck (Desktop Mode) pactl is
  // present and the PipeWire-Pulse compat layer answers these.
  let sink = run("pactl", &["get-default-sink"])?
    .trim().to_string();
  if sink.is_empty() {
    return Err("no default audio sink reported by pactl".into());
  }

  // The monitor of the default sink is the normal capture path. If remap
  // loading fails, the caller degrades honestly to video-only.
  let monitor = format!("{sink}.monitor");

  // The hidden source is "really the audio": the desktop mix, nothing else.
  // Idempotent — a previous crashed run doesn't duplicate it.
  let sources = run("pactl", &["list", "short", "sources"]).unwrap_or_default();
  if sources.lines().any(|l| l.contains(SOURCE_NAME)) {
    LOADED_BY_US.store(true, Ordering::SeqCst);
    return Ok("hidden device already present (reused)".into());
  }

  run("pactl", &[
    "load-module", "module-remap-source",
    &format!("master={monitor}"),
    &format!("source_name={SOURCE_NAME}"),
    &format!("source_properties=device.description={SOURCE_DESC}"),
  ])?;
  LOADED_BY_US.store(true, Ordering::SeqCst);
  Ok("hidden device created (monitor of default sink)".into())
}

#[cfg(target_os = "linux")]
pub(crate) fn teardown() {
  if !LOADED_BY_US.swap(false, Ordering::SeqCst) {
    return; // not ours — leave a pre-existing device alone
  }
  if let Ok(modules) = run("pactl", &["list", "short", "modules"]) {
    for line in modules.lines() {
      if line.contains(SOURCE_NAME) {
        if let Some(id) = line.split_whitespace().next() {
          let _ = run("pactl", &["unload-module", id]);
        }
      }
    }
  }
}

#[cfg(not(target_os = "linux"))]
fn setup() -> Result<String, String> {
  Err("native desktop-audio capture is only built for Linux right now \
       (WASAPI loopback backend is the Windows phase-2, not present here)".into())
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn teardown() {}

#[tauri::command]
pub fn audio_setup() -> AudioState {
  match setup() {
    Ok(reason) => AudioState { ok: true, reason },
    Err(reason) => AudioState { ok: false, reason },
  }
}

#[tauri::command]
pub fn audio_teardown() -> AudioState {
  teardown();
  AudioState { ok: true, reason: "torn down".into() }
}
