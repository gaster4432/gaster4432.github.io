//! Input injection via uinput (Linux). Mirrors the exact key map of
//! `peek-inject` — the two are deliberately kept identical; keep them in sync.
//! The caller gates this behind its consent flag before calling.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum InjectEvent {
    MouseMove { x: f64, y: f64 },
    MouseDown { button: u8 },
    MouseUp { button: u8 },
    Wheel { dy: f64 },
    KeyDown { code: String },
    KeyUp { code: String },
}

pub fn parse_msg_json(msg: &str) -> Result<InjectEvent, String> {
    serde_json::from_str::<InjectEvent>(msg).map_err(|e| format!("input event not understood: {e}"))
}

#[cfg(target_os = "linux")]
use evdev::{AbsoluteAxisCode, AttributeSet, InputEvent, KeyCode, RelativeAxisCode, UinputAbsSetup, AbsInfo};
#[cfg(target_os = "linux")]
use evdev::uinput::VirtualDevice;

#[cfg(target_os = "linux")]
const EV_KEY: u16 = 0x01;
#[cfg(target_os = "linux")]
const EV_REL: u16 = 0x02;
#[cfg(target_os = "linux")]
const EV_ABS: u16 = 0x03;

#[cfg(target_os = "linux")]
static DEVICE: std::sync::OnceLock<std::sync::Mutex<Option<VirtualDevice>>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "linux")]
fn build_device() -> Result<VirtualDevice, String> {
    let keys = AttributeSet::<KeyCode>::from_iter((0u16..256).map(KeyCode::new));
    let abs_x = UinputAbsSetup::new(AbsoluteAxisCode::ABS_X, AbsInfo::new(0, 65535, 0, 0, 0, 0));
    let abs_y = UinputAbsSetup::new(AbsoluteAxisCode::ABS_Y, AbsInfo::new(0, 65535, 0, 0, 0, 0));
    let rels = AttributeSet::<RelativeAxisCode>::from_iter([RelativeAxisCode::REL_WHEEL]);

    VirtualDevice::builder()
        .map_err(|e| format!("uinput: /dev/uinput unavailable ({e}). Talk to the uinput rule / wiring."))?
        .name("peek-remote")
        .with_keys(&keys)
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

#[cfg(target_os = "linux")]
fn emit(events: &[InputEvent]) -> Result<(), String> {
    let dev = DEVICE.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = dev.lock().map_err(|_| "virtual device lock poisoned")?;
    if guard.is_none() {
        *guard = Some(build_device()?);
    }
    guard
        .as_mut()
        .expect("virtual device slot was just filled")
        .emit(events)
        .map_err(|e| format!("uinput emit failed: {e}"))
}

#[cfg(target_os = "linux")]
pub fn inject(event: &InjectEvent) -> Result<(), String> {
    let emit = |events: &[InputEvent]| emit(events);
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
            let step = if *dy > 0.0 { -1 } else if *dy < 0.0 { 1 } else { return Ok(()) };
            emit(&[InputEvent::new(EV_REL, RelativeAxisCode::REL_WHEEL.0, step)])
        }
        InjectEvent::KeyDown { code } => key(code, true),
        InjectEvent::KeyUp { code } => key(code, false),
    }
}

#[cfg(target_os = "linux")]
fn key(code: &str, down: bool) -> Result<(), String> {
    let scancode = js_code_to_evdev(code).ok_or_else(|| format!("key not forwarded: {code}"))?;
    emit(&[InputEvent::new(EV_KEY, scancode, down as i32)])
}

#[cfg(not(target_os = "linux"))]
pub fn inject(_event: &InjectEvent) -> Result<(), String> {
    Err("input injection is only supported on Linux (Deck/SteamOS) in this build".into())
}

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
