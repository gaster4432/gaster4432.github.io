// Non-Linux stand-in for the native GStreamer host.
//
// The share pipeline is Linux-only: it needs GStreamer system libraries and
// (on Wayland) the xdg-desktop-portal. On other platforms the commands
// exist but fail loudly, rather than disappearing or pretending to work.

use tauri::AppHandle;

pub fn announce_gate(_enabled: bool) {}

pub async fn start(_app: AppHandle, _mode: Option<String>) -> Result<String, String> {
    Err("native screen share is only available on Linux (Steam Deck / Plasma) — this build has no GStreamer host".into())
}

pub fn stop(_app: &AppHandle) {}

pub fn running_code() -> Option<String> {
    None
}
