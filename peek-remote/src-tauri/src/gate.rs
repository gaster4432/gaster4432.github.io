// The one and only gate for remote input injection.
//
// CONTROL is a single AtomicBool shared by:
//   * `set_control` command (the webview asks; only the host's own click
//     toggles it — enforced in Rust),
//   * the Ctrl+Alt+Q kill hotkey on Windows,
//   * the native data-channel input path (the friend's keys/mouse).

use std::sync::atomic::{AtomicBool, Ordering};

static CONTROL: AtomicBool = AtomicBool::new(false);

pub fn is_open() -> bool {
    CONTROL.load(Ordering::SeqCst)
}

pub fn set(enabled: bool) {
    CONTROL.store(enabled, Ordering::SeqCst);
}
