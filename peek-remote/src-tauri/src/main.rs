// Peek Remote — the Rust half of the app.
//
// Safety model:
//   * `CONTROL` (AtomicBool) is the ONLY gate for input injection. The
//     frontend can ask to flip it (`set_control`), the host's own click
//     toggles it, and Ctrl+Alt+Q forces it off from anywhere on Windows.
//   * The viewer machine cannot inject until the host flips the toggle.
//   * A page bug or a malicious `inject` call with the flag off is a no-op.
//
// Protocol: identical to peek/index.html — same v4 mailbox, same codes.
// Input (joiner → host) rides an RTCDataChannel created by the host inside
// the existing WebRTC offer, so the signaling server never changes.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod input;

use audio::{audio_setup, audio_teardown};
use input::InjectEvent;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

static CONTROL: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
pub struct ControlState {
  enabled: bool,
}

#[tauri::command]
fn set_control(enabled: bool, app: tauri::AppHandle) -> Result<ControlState, String> {
  CONTROL.store(enabled, Ordering::SeqCst);
  use tauri::Emitter;
  app.emit("control-state", ControlState { enabled }).map_err(|e| e.to_string())?;
  Ok(ControlState { enabled })
}

#[tauri::command]
fn control_state() -> ControlState {
  ControlState { enabled: CONTROL.load(Ordering::SeqCst) }
}

#[tauri::command]
fn inject(event: InjectEvent) -> Result<(), String> {
  if !CONTROL.load(Ordering::SeqCst) {
    return Err("control is not allowed on this machine".into());
  }
  input::inject(event)
}

/// Windows-only global panic hotkey: Ctrl+Alt+Q cuts remote control
/// regardless of focus. Wayland cannot offer a compositor-independent
/// global grab, so on Linux the always-on-top window's STOP button is the
/// escape hatch (documented in the README).
#[cfg(windows)]
fn install_kill_hotkey(app: tauri::AppHandle) {
  std::thread::spawn(move || {
    use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT};
    use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

    unsafe {
      if RegisterHotKey(None, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x51).is_err() {
        eprintln!("[peek-remote] Ctrl+Alt+Q kill hotkey registration failed");
        return;
      }
      let mut msg = MSG::default();
      loop {
        let r = GetMessageW(&mut msg, None, 0, 0);
        if r.0 <= 0 { break; }
        if msg.message == WM_HOTKEY {
          CONTROL.store(false, Ordering::SeqCst);
          use tauri::Emitter;
          let _ = app.emit("control-cut", ());
        }
      }
    }
  });
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      #[cfg(windows)]
      install_kill_hotkey(app.handle().clone());
      let _ = app.handle(); // window configured alwaysOnTop in tauri.conf.json
      Ok(())
    })
    // Unload our hidden audio device when the window is closed properly.
    // The JS half also calls audio_teardown on dispose; this is the backstop.
    .on_window_event(|_window, event| {
      if let tauri::WindowEvent::CloseRequested { .. } = event {
        audio::teardown();
      }
    })
    .invoke_handler(tauri::generate_handler![set_control, control_state, inject, audio_setup, audio_teardown])
    .run(tauri::generate_context!())
    .expect("error while running Peek Remote");
}
