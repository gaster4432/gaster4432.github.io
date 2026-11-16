// Input injection backends, one per platform. Selected at compile time —
// everything here is only reachable through `inject()` in main.rs, which
// refuses to run while the consent flag is off.
//
// Window-control note: this is deliberately NOT behind the Tauri event
// system. The Rust flag is the source of truth; the frontend can ask,
// only the host's own click (or Ctrl+Alt+Q on Windows) flips it.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum InjectEvent {
  MouseMove { x: f64, y: f64 },
  MouseDown { button: u8 },
  MouseUp { button: u8 },
  Wheel { dy: f64 },
  KeyDown { code: String },
  KeyUp { code: String },
}

#[cfg(windows)]
mod imp {
  use super::InjectEvent;
  use windows::Win32::UI::Input::KeyboardAndMouse::*;

  fn mouse_event(dx: i32, dy: i32, mouse_data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
      r#type: INPUT_MOUSE,
      Anonymous: INPUT_0 {
        mi: MOUSEINPUT {
          dx,
          dy,
          mouseData: mouse_data as u32,
          dwFlags: flags,
          time: 0,
          dwExtraInfo: 0,
        },
      },
    }
  }

  fn absolute_move(x: f64, y: f64) {
    // MOUSEEVENTF_VIRTUALDESK: 0..65535 spans all monitors.
    let ax = (x.clamp(0.0, 1.0) * 65535.0) as i32;
    let ay = (y.clamp(0.0, 1.0) * 65535.0) as i32;
    let flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    let input = mouse_event(ax, ay, 0, flags);
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
  }

  fn mouse_button(button: u8, down: bool) {
    let (down_f, up_f) = match button {
      0 => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
      1 => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
      2 => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
      _ => return,
    };
    let flags = if down { down_f } else { up_f };
    let input = mouse_event(0, 0, 0, flags);
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
  }

  fn wheel(dy: f64) {
    // JS deltaY is positive when scrolling down; Windows wants negative for "away".
    let step = if dy > 0.0 { -120 } else if dy < 0.0 { 120 } else { return };
    let input = mouse_event(0, 0, step, MOUSEEVENTF_WHEEL);
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
  }

  /// Map a DOM KeyboardEvent.code to a virtual-key code. Returns None for
  /// keys we deliberately do not forward (e.g. F-keys of the host session).
  fn vk_of(code: &str) -> Option<u16> {
    Some(match code {
      "KeyA" => 0x41, "KeyB" => 0x42, "KeyC" => 0x43, "KeyD" => 0x44,
      "KeyE" => 0x45, "KeyF" => 0x46, "KeyG" => 0x47, "KeyH" => 0x48,
      "KeyI" => 0x49, "KeyJ" => 0x4A, "KeyK" => 0x4B, "KeyL" => 0x4C,
      "KeyM" => 0x4D, "KeyN" => 0x4E, "KeyO" => 0x4F, "KeyP" => 0x50,
      "KeyQ" => 0x51, "KeyR" => 0x52, "KeyS" => 0x53, "KeyT" => 0x54,
      "KeyU" => 0x55, "KeyV" => 0x56, "KeyW" => 0x57, "KeyX" => 0x58,
      "KeyY" => 0x59, "KeyZ" => 0x5A,
      "Digit0" => 0x30, "Digit1" => 0x31, "Digit2" => 0x32, "Digit3" => 0x33,
      "Digit4" => 0x34, "Digit5" => 0x35, "Digit6" => 0x36, "Digit7" => 0x37,
      "Digit8" => 0x38, "Digit9" => 0x39,
      "F1" => 0x70, "F2" => 0x71, "F3" => 0x72, "F4" => 0x73,
      "F5" => 0x74, "F6" => 0x75, "F7" => 0x76, "F8" => 0x77,
      "F9" => 0x78, "F10" => 0x79, "F11" => 0x7A, "F12" => 0x7B,
      "F13" => 0x7C, "F14" => 0x7D, "F15" => 0x7E, "F16" => 0x7F,
      "F17" => 0x80, "F18" => 0x81, "F19" => 0x82, "F20" => 0x83,
      "F21" => 0x84, "F22" => 0x85, "F23" => 0x86, "F24" => 0x87,
      "ArrowLeft" => 0x25, "ArrowUp" => 0x26, "ArrowRight" => 0x27, "ArrowDown" => 0x28,
      "Space" => 0x20, "Enter" => 0x0D, "Escape" => 0x1B, "Tab" => 0x09,
      "Backspace" => 0x08, "Delete" => 0x2E, "Insert" => 0x2D,
      "Home" => 0x24, "End" => 0x23, "PageUp" => 0x21, "PageDown" => 0x22,
      "Minus" => 0xBD, "Equal" => 0xBB, "BracketLeft" => 0xDB, "BracketRight" => 0xDD,
      "Backslash" => 0xDC, "Semicolon" => 0xBA, "Quote" => 0xDE, "Backquote" => 0xC0,
      "Comma" => 0xBC, "Period" => 0xBE, "Slash" => 0xBF,
      "ShiftLeft" => 0xA0, "ShiftRight" => 0xA1,
      "ControlLeft" => 0xA2, "ControlRight" => 0xA3,
      "AltLeft" => 0xA4, "AltRight" => 0xA5,
      "MetaLeft" => 0x5B, "MetaRight" => 0x5C, "ContextMenu" => 0x5D,
      "CapsLock" => 0x14, "NumLock" => 0x90, "ScrollLock" => 0x91,
      "PrintScreen" => 0x2C, "Pause" => 0x13,
      _ => return None,
    })
  }

  fn key(code: &str, down: bool) -> Result<(), String> {
    let vk = vk_of(code).ok_or_else(|| format!("key not forwarded: {code}"))?;
    let flags = if down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP };
    let input = INPUT {
      r#type: INPUT_KEYBOARD,
      Anonymous: INPUT_0 {
        ki: KEYBDINPUT {
          wVk: VIRTUAL_KEY(vk),
          wScan: 0,
          dwFlags: flags,
          time: 0,
          dwExtraInfo: 0,
        },
      },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    Ok(())
  }

  pub fn inject(event: InjectEvent) -> Result<(), String> {
    match event {
      InjectEvent::MouseMove { x, y } => { absolute_move(x, y); Ok(()) }
      InjectEvent::MouseDown { button } => { mouse_button(button, true); Ok(()) }
      InjectEvent::MouseUp { button } => { mouse_button(button, false); Ok(()) }
      InjectEvent::Wheel { dy } => { wheel(dy); Ok(()) }
      InjectEvent::KeyDown { code } => key(&code, true),
      InjectEvent::KeyUp { code } => key(&code, false),
    }
  }
}

#[cfg(target_os = "linux")]
mod imp {
  use super::InjectEvent;
  use evdev::uinput::VirtualDevice;
  use evdev::{AbsInfo, AbsoluteAxisCode, AttributeSet, InputEvent, KeyCode, RelativeAxisCode, UinputAbsSetup};
  use std::sync::Mutex;

  const EV_KEY: u16 = 0x01;
  const EV_REL: u16 = 0x02;
  const EV_ABS: u16 = 0x03;

  static DEVICE: Mutex<Option<VirtualDevice>> = Mutex::new(None);

  /// evdev scancodes for every DOM key we forward. BTN_LEFT/RIGHT/MIDDLE
  /// are in the 0x110 range and ride in the same set.
  const KEYS: &[u16] = &[
    2, 3, 4, 5, 6, 7, 8, 9, 10, 11,        // KEY_1..KEY_0
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25, // KEY_Q..KEY_P
    30, 31, 32, 33, 34, 35, 36, 37, 38,    // KEY_A..KEY_L
    44, 45, 46, 47, 48, 49, 50,            // KEY_Z..KEY_M
    28, 1, 15, 14, 57, 58,                 // enter, esc, tab, backspace, space, capslock
    42, 54, 29, 97, 56, 100,               // shift, rshift, ctrl, rctrl, alt, ralt
    125, 126,                              // meta left/right
    59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, // F1..F12
    103, 106, 108, 105,                    // up, right, down, left
    102, 107, 104, 109,                    // home, end, pageup, pagedown
    110, 111,                              // insert, delete
    12, 13, 26, 27, 43, 39, 40, 41, 51, 52, 53, // - = [ ] \ ; ' , . /
    41, 71, 82, 99,                        // grave, numlock, scrolllock, printscreen
    119,                                    // pause
    139,                                    // menu (KEY_CONTEXT_MENU)
    0x110, 0x111, 0x112,                    // BTN_LEFT, BTN_RIGHT, BTN_MIDDLE
  ];

  fn key_set() -> AttributeSet<KeyCode> {
    let mut set = AttributeSet::<KeyCode>::new();
    for &code in KEYS.iter() { set.insert(KeyCode::new(code)); }
    set
  }

  fn build_device() -> Result<VirtualDevice, String> {
    let abs_x = UinputAbsSetup::new(AbsoluteAxisCode::ABS_X, AbsInfo::new(0, 65535, 0, 0, 0, 0));
    let abs_y = UinputAbsSetup::new(AbsoluteAxisCode::ABS_Y, AbsInfo::new(0, 65535, 0, 0, 0, 0));
    let rels = AttributeSet::<RelativeAxisCode>::from_iter([RelativeAxisCode::REL_WHEEL]);
    VirtualDevice::builder()
      .map_err(|e| format!("uinput: /dev/uinput unavailable ({e}). Run with sudo or add a udev rule + uinput group."))?
      .name("peek-remote")
      .with_keys(&key_set())
      .map_err(|e| e.to_string())?
      .with_absolute_axis(&abs_x)
      .map_err(|e| e.to_string())?
      .with_absolute_axis(&abs_y)
      .map_err(|e| e.to_string())?
      .with_relative_axes(&rels)
      .map_err(|e| e.to_string())?
      .build()
      .map_err(|e| e.to_string())
  }

  fn emit(events: &[InputEvent]) -> Result<(), String> {
    let mut guard = DEVICE.lock().map_err(|_| "virtual device lock poisoned")?;
    if guard.is_none() {
      *guard = Some(build_device()?);
    }
    guard.as_mut().unwrap().emit(events).map_err(|e| format!("uinput emit failed: {e}"))
  }

  fn abs_move(x: f64, y: f64) -> Result<(), String> {
    let ax = (x.clamp(0.0, 1.0) * 65535.0) as i32;
    let ay = (y.clamp(0.0, 1.0) * 65535.0) as i32;
    emit(&[
      InputEvent::new(EV_ABS, AbsoluteAxisCode::ABS_X.0, ax),
      InputEvent::new(EV_ABS, AbsoluteAxisCode::ABS_Y.0, ay),
    ])
  }

  fn mouse_button(button: u8, down: bool) -> Result<(), String> {
    let code = match button {
      0 => KeyCode::BTN_LEFT.0,
      1 => KeyCode::BTN_MIDDLE.0,
      2 => KeyCode::BTN_RIGHT.0,
      _ => return Ok(()),
    };
    emit(&[InputEvent::new(EV_KEY, code, down as i32)])
  }

  fn wheel(dy: f64) -> Result<(), String> {
    let step = if dy > 0.0 { -1 } else if dy < 0.0 { 1 } else { return Ok(()) };
    emit(&[InputEvent::new(EV_REL, RelativeAxisCode::REL_WHEEL.0, step)])
  }

  /// DOM KeyboardEvent.code → evdev scancode.
  fn key_code(code: &str) -> Option<u16> {
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
      "ShiftLeft" => 42, "ShiftRight" => 54,
      "ControlLeft" => 29, "ControlRight" => 97,
      "AltLeft" => 56, "AltRight" => 100,
      "MetaLeft" => 125, "MetaRight" => 126, "ContextMenu" => 139,
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

  fn key(code: &str, down: bool) -> Result<(), String> {
    let scancode = key_code(code).ok_or_else(|| format!("key not forwarded: {code}"))?;
    emit(&[InputEvent::new(EV_KEY, scancode, down as i32)])
  }

  pub fn inject(event: InjectEvent) -> Result<(), String> {
    match event {
      InjectEvent::MouseMove { x, y } => abs_move(x, y),
      InjectEvent::MouseDown { button } => mouse_button(button, true),
      InjectEvent::MouseUp { button } => mouse_button(button, false),
      InjectEvent::Wheel { dy } => wheel(dy),
      InjectEvent::KeyDown { code } => key(&code, true),
      InjectEvent::KeyUp { code } => key(&code, false),
    }
  }
}

#[cfg(windows)]
pub use imp::inject;
#[cfg(target_os = "linux")]
pub use imp::inject;

#[cfg(not(any(windows, target_os = "linux")))]
pub fn inject(_event: InjectEvent) -> Result<(), String> {
  Err("peek-remote: unsupported platform (Windows + Linux only for now)".into())
}
