// Peek Remote injector — the friend's half of the remote desktop.
//
// What it is: a localhost daemon. It serves the share/watch page on
// http://127.0.0.1:8753/ (a *secure context*, so getDisplayMedia works in a
// real browser), and exposes POST /inject which applies input events to the
// machine via a virtual /dev/uinput device.
//
// What it is not: network-reachable. Binds loopback only.
//
// Security model: the page is served only to you, with a fresh random token
// baked into it on first launch (meta tag `peek-token`). POST /inject requires
// the same token via the X-Peek-Token header — any other website open in
// this browser is blind to it. The token never leaves this machine.
//
// Flow: friend opens 127.0.0.1:8753 → shares screen (browser captures) →
// you join from https://gaster4432.github.io/peek-remote/watch/ (or the same
// page) → your mouse/keys flow over the WebRTC data channel into their
// browser page → POST /inject → uinput → their desktop.

use std::io::Read;
use std::sync::{Mutex, OnceLock};

#[derive(serde::Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum InjectEvent {
  MouseMove { x: f64, y: f64 },
  MouseDown { button: u8 },
  MouseUp { button: u8 },
  Wheel { dy: f64 },
  KeyDown { code: String },
  KeyUp { code: String },
}

#[cfg(target_os = "linux")]
use evdev::uinput::VirtualDevice;
static TOKEN: OnceLock<String> = OnceLock::new();
#[cfg(target_os = "linux")]
static DEVICE: OnceLock<Mutex<VirtualDevice>> = OnceLock::new();
#[cfg(target_os = "linux")]
use evdev::{AbsoluteAxisCode, AttributeSet, InputEvent, KeyCode, RelativeAxisCode, UinputAbsSetup, AbsInfo};

#[cfg(target_os = "linux")]
const EV_KEY: u16 = 0x01;
#[cfg(target_os = "linux")]
const EV_REL: u16 = 0x02;
#[cfg(target_os = "linux")]
const EV_ABS: u16 = 0x03;

#[cfg(target_os = "linux")]
fn build_device() -> Result<VirtualDevice, String> {
  let keys = AttributeSet::<KeyCode>::from_iter((0u16..256).map(KeyCode::new));
  let abs_x = UinputAbsSetup::new(AbsoluteAxisCode::ABS_X, AbsInfo::new(0, 65535, 0, 0, 0, 0));
  let abs_y = UinputAbsSetup::new(AbsoluteAxisCode::ABS_Y, AbsInfo::new(0, 65535, 0, 0, 0, 0));
  let rels = AttributeSet::<RelativeAxisCode>::from_iter([RelativeAxisCode::REL_WHEEL]);
  VirtualDevice::builder()
    .map_err(|e| format!("uinput: /dev/uinput unavailable ({e}). Talk to the uinput rule / wiring."))?
    .name("peek-remote")
    .with_keys(&keys).map_err(|e| e.to_string())?
    .with_absolute_axis(&abs_x).map_err(|e| e.to_string())?
    .with_absolute_axis(&abs_y).map_err(|e| e.to_string())?
    .with_relative_axes(&rels).map_err(|e| e.to_string())?
    .build()
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn emit(events: &[InputEvent]) -> Result<(), String> {
  let dev = DEVICE.get_or_try_init(|| build_device().map(Mutex::new))?;
  let mut d = dev.lock().map_err(|_| "virtual device lock poisoned")?;
  d.emit(events).map_err(|e| format!("uinput emit failed: {e}"))
}

#[cfg(target_os = "linux")]
fn inject(event: InjectEvent) -> Result<(), String> {
  match event {
    InjectEvent::MouseMove { x, y } => {
      let ax = (x.clamp(0.0, 1.0) * 65535.0) as i32;
      let ay = (y.clamp(0.0, 1.0) * 65535.0) as i32;
      emit(&[
        InputEvent::new(EV_ABS, AbsoluteAxisCode::ABS_X.0, ax),
        InputEvent::new(EV_ABS, AbsoluteAxisCode::ABS_Y.0, ay),
      ])
    }
    InjectEvent::MouseDown { button } => {
      let code = match button { 0 => KeyCode::BTN_LEFT.0, 1 => KeyCode::BTN_MIDDLE.0, 2 => KeyCode::BTN_RIGHT.0, _ => return Ok(()) };
      emit(&[InputEvent::new(EV_KEY, code, 1)])
    }
    InjectEvent::MouseUp { button } => {
      let code = match button { 0 => KeyCode::BTN_LEFT.0, 1 => KeyCode::BTN_MIDDLE.0, 2 => KeyCode::BTN_RIGHT.0, _ => return Ok(()) };
      emit(&[InputEvent::new(EV_KEY, code, 0)])
    }
    InjectEvent::Wheel { dy } => {
      let step = if dy > 0.0 { -1 } else if dy < 0.0 { 1 } else { return Ok(()) };
      emit(&[InputEvent::new(EV_REL, RelativeAxisCode::REL_WHEEL.0, step)])
    }
    InjectEvent::KeyDown { code } => key(&code, true),
    InjectEvent::KeyUp { code } => key(&code, false),
  }
}

#[cfg(target_os = "linux")]
fn key(code: &str, down: bool) -> Result<(), String> {
  let scancode = js_code_to_evdev(code).ok_or_else(|| format!("key not forwarded: {code}"))?;
  emit(&[InputEvent::new(EV_KEY, scancode, down as i32)])
}

#[cfg(not(target_os = "linux"))]
fn inject(_event: InjectEvent) -> Result<(), String> { Err("unsupported platform".into()) }

#[cfg(target_os = "linux")]
fn js_code_to_evdev(code: &str) -> Option<u16> {
  Some(match code {
    "Digit1" => 2, "Digit2" => 3, "Digit3" => 4, "Digit4" => 5, "Digit5" => 6,
    "Digit6" => 7, "Digit7" => 8, "Digit8" => 9, "Digit9" => 10, "Digit0" => 11,
    "KeyQ" => 16, "KeyW" => 17, "KeyE" => 18, "KeyR" => 19, "KeyT" => 20,
    "KeyY" => 21, "KeyU" => 22, "KeyI" => 23, "KeyO" => 24, "KeyP" => 25,
    "KeyA" => 30, "KeyS" => 31, "KeyD" => 32, "KeyF" => 33, "KeyG" => 34,
    "KeyH" => 35, "KeyJ" => 36, "KeyK" => 37, "KeyL" => 38,
    "KeyZ" => 44, "KeyX" => 45, "KeyC" => 46, "KeyV" => 47, "KeyB" => 48,
    "KeyN" => 49, "KeyM" => 50,
    "Enter" => 28, "Escape" => 1, "Tab" => 15, "Backspace" => 14, "Space" => 57,
    "ShiftLeft" => 42, "ShiftRight" => 54, "ControlLeft" => 29, "ControlRight" => 97,
    "AltLeft" => 56, "AltRight" => 100, "MetaLeft" => 125, "MetaRight" => 126, "ContextMenu" => 139,
    "CapsLock" => 58, "NumLock" => 71, "ScrollLock" => 82,
    "PrintScreen" => 99, "Pause" => 119,
    "F1" => 59, "F2" => 60, "F3" => 61, "F4" => 62,
    "F5" => 63, "F6" => 64, "F7" => 65, "F8" => 66,
    "F9" => 67, "F10" => 68, "F11" => 87, "F12" => 88,
    "ArrowUp" => 103, "ArrowRight" => 106, "ArrowDown" => 108, "ArrowLeft" => 105,
    "Home" => 102, "End" => 107, "PageUp" => 104, "PageDown" => 109,
    "Insert" => 110, "Delete" => 111,
    "Minus" => 12, "Equal" => 13, "BracketLeft" => 26, "BracketRight" => 27,
    "Backslash" => 43, "Semicolon" => 39, "Quote" => 40, "Backquote" => 41,
    "Comma" => 51, "Period" => 52, "Slash" => 53,
    _ => return None,
  })
}

const INDEX_HTML: &str = include_str!("../www/index.html");
const MAIN_JS: &str = include_str!("../www/main.js");
const STYLES_CSS: &str = include_str!("../www/styles.css");

fn token() -> &'static str {
  TOKEN.get_or_init(|| {
    (0..32).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
  })
}

fn header(name: &str, value: &str) -> tiny_http::Header {
  tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn respond_html(req: tiny_http::Request, body: String) {
  let res = tiny_http::Response::from_string(body)
    .with_status_code(200)
    .with_header(header("Content-Type", "text/html; charset=utf-8"));
  let _ = req.respond(res);
}

fn main() {
  let port = std::env::var("PEEK_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(8753);
  let addr = format!("127.0.0.1:{port}");
  let server = tiny_http::Server::http(&addr).unwrap_or_else(|e| {
    eprintln!("peek-inject: cannot bind {addr}: {e}");
    std::process::exit(1);
  });
  let tok = token().to_string();
  println!("peek-inject listening on http://127.0.0.1:{port}/");
  println!("share page → http://127.0.0.1:{port}/ (your friend opens this)");
  for mut req in server.incoming_requests() {
    let url = req.url().to_string();
    let method = req.method().to_string();
    match (method.as_str(), url.as_str()) {
      ("GET", "/") => respond_html(req, INDEX_HTML.replace("__PEEK_TOKEN__", &tok)),
      ("GET", "/src/main.js") => {
        let res = tiny_http::Response::from_string(MAIN_JS)
          .with_status_code(200)
          .with_header(header("Content-Type", "application/javascript; charset=utf-8"));
        let _ = req.respond(res);
      }
      ("GET", "/src/styles.css") => {
        let res = tiny_http::Response::from_string(STYLES_CSS)
          .with_status_code(200)
          .with_header(header("Content-Type", "text/css; charset=utf-8"));
        let _ = req.respond(res);
      }
      ("GET", "/health") => {
        let res = tiny_http::Response::from_string(r#"{"ok":true,"service":"peek-inject","protocol":1}"#)
          .with_status_code(200)
          .with_header(header("Content-Type", "application/json"))
          .with_header(header("Access-Control-Allow-Origin", "*"));
        let _ = req.respond(res);
      }
      ("OPTIONS", _) => {
        let res = tiny_http::Response::empty(204)
          .with_header(header("Access-Control-Allow-Origin", "*"))
          .with_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
          .with_header(header("Access-Control-Allow-Headers", "Content-Type, X-Peek-Token"));
        let _ = req.respond(res);
      }
      ("POST", "/inject") => {
        let ok_tok = req
          .headers()
          .iter()
          .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("x-peek-token"))
          .map(|h| h.value.as_str() == tok.as_str())
          .unwrap_or(false);
        if !ok_tok {
          let res = tiny_http::Response::from_string(r#"{"error":"bad_token"}"#)
            .with_status_code(403)
            .with_header(header("Content-Type", "application/json"));
          let _ = req.respond(res);
          continue;
        }
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let status = match serde_json::from_str::<InjectEvent>(&body) {
          Ok(ev) => match inject(ev) {
            Ok(()) => (200, r#"{"ok":true}"#),
            Err(e) => (500, &format!(r#"{{"error":"{e}"}}"#)),
          },
          Err(e) => {
            let msg = format!("invalid json ({e})");
            (400, &format!(r#"{{"error":"{}"}}"#, msg.replace('"', "'")))
          }
        };
        let res = tiny_http::Response::from_string(status.1.to_string())
          .with_status_code(status.0)
          .with_header(header("Content-Type", "application/json"))
          .with_header(header("Access-Control-Allow-Origin", "*"));
        let _ = req.respond(res);
      }
      _ => {
        let res = tiny_http::Response::empty(404);
        let _ = req.respond(res);
      }
    }
  }
}
