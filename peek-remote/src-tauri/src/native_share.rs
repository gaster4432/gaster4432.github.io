// Native GStreamer screen-share for the Steam Deck / Wayland path.
//
// The webview performs no WebRTC work of its own here. One command builds
// and starts the pipeline:
//   start_native_share: portal (or test pattern) → pipewiresrc → x264enc
//     → webrtcbin → mailbox; returns the room code the friend types in.
//   stop_native_share: tears the pipeline down.
//
// Consent flows exactly as before: CONTROL (AtomicBool, gate.rs) gates the
// friend's input. The friend's input arrives over the peek-remote-control
// data channel the host creates; Rust parses and injects via uinput.

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use serde::Serialize;
use tauri::Emitter;
use gstreamer::prelude::*;

use peek_rt::mailbox::Event;

static SHARE: Mutex<Option<NativeShare>> = Mutex::new(None);

/// The control channel outlives the share; kept so the host can announce the
/// consent gate to the friend (JS itself no longer sends over the channel).
static CONTROL_CHANNEL: Mutex<Option<SendableChannel>> = Mutex::new(None);

/// glib Object wrappers aren't declared Send+Sync by the bindings; the
/// underlying GstWebRTCDataChannel is ref-counted and thread-safe by design.
struct SendableChannel(gstreamer_webrtc::WebRTCDataChannel);
unsafe impl Send for SendableChannel {}
unsafe impl Sync for SendableChannel {}

/// Tell the friend whether control is armed. No-op if no channel exists.
pub fn announce_gate(enabled: bool) {
    let msg = serde_json::json!({ "t": "gate", "on": enabled }).to_string();
    if let Ok(guard) = CONTROL_CHANNEL.lock() {
        if let Some(ch) = guard.as_ref() {
            ch.0.send_string(Some(&msg));
        }
    }
}

pub struct NativeShare {
    share: peek_rt::PeekShare,
    stop: Arc<AtomicBool>,
    // Keep the portal session + fd alive for as long as capture runs.
    _portal: Option<peek_rt::portal::ScreencastPick>,
    pub code: String,
}

impl NativeShare {
    fn set_null(self) {
        self.stop.store(true, Ordering::SeqCst);
        self.share.stop();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub struct NativeEvent {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn emit_app(app: &tauri::AppHandle, kind: &str, message: Option<String>) {
    let _ = app.emit("native-share", NativeEvent { kind: kind.into(), message });
}

/// Build the share (portal screencast on Wayland, else falling back to the
/// synthetic pattern on machines without a portal). `mode` lets callers force
/// `"test-pattern"` for development.
pub async fn build_share(
    mode: Option<String>,
) -> Result<(peek_rt::PeekShare, Option<peek_rt::portal::ScreencastPick>), String> {
    if mode.as_deref() == Some("test-pattern") {
        return peek_rt::PeekShare::test_pattern().map(|s| (s, None));
    }

    // Wayland path: ask the portal which window/monitor to share.
    let pick = peek_rt::portal::pick_screencast().await?;
    let fd = pick.fd_raw();
    let node_id = pick.node_id;
    let share = peek_rt::PeekShare::pipewire(fd, node_id)?;
    Ok((share, Some(pick)))
}

/// Launch the native pipeline and return the room code. The actual offer is
/// created asynchronously once the pipeline negotiates.
pub async fn start(app: tauri::AppHandle, mode: Option<String>) -> Result<String, String> {
    if SHARE.lock().map_err(|_| "native share state poisoned")?.is_some() {
        return Err("a native share is already running — stop it first".into());
    }

    let sid = format!("host-{}", std::process::id());
    let room = peek_rt::mailbox::Room::create(&sid)?;
    let code = room.code.clone();

    let room = Arc::new(room);
    let (share, portal) = build_share(mode).await?;
    let webrtc = share.webrtc().clone();

    // Offer/ICE handlers → mailbox.
    peek_rt::install_handlers(
        &webrtc,
        {
            let room = room.clone();
            move |sdp: String| {
                if let Err(e) = room.offer(&sdp) {
                    eprintln!("[native-share] offer post failed: {e}");
                }
            }
        },
        {
            let room = room.clone();
            move |mline, candidate| {
                if let Err(e) = room.ice(mline, &candidate) {
                    eprintln!("[native-share] ice post failed: {e}");
                }
            }
        },
    );

    // webrtcbin only accepts data channels after leaving NULL. Prime, create,
    // then play — so the channel exists in the very first offer.
    share.prime_paused()?;
    let channel = share.create_control_channel()?;
    {
        // Announce the current gate state as soon as the channel opens, and
        // keep a handle so set_control() can announce flips later.
        channel.connect_on_open(move |_| {
            announce_gate(crate::gate::is_open());
        });
        CONTROL_CHANNEL.lock().map_err(|_| "control channel lock poisoned")?
            .replace(SendableChannel(channel.clone()));
    }

    {
        let app_for_msg = app.clone();
        peek_rt::install_input_handler(&channel, move |msg| {
            let ctrl =
                crate::gate::is_open();
            if !ctrl {
                eprintln!("[native-share] input gated (dropped): {msg}");
                return;
            }
            // Consent grab/release announcements: let the JS UI react.
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg) {
                if v.get("t").and_then(|t| t.as_str()) == Some("grab") {
                    let on = v.get("on").and_then(|n| n.as_bool()).unwrap_or(false);
                    let _ = app_for_msg.emit(
                        "control-grab",
                        serde_json::json!({ "on": on }),
                    );
                    return;
                }
            }
            match peek_rt::input::parse_msg_json(&msg) {
                Ok(event) => {
                    if let Err(e) = peek_rt::input::inject(&event) {
                        eprintln!("[native-share] inject failed: {e}");
                    }
                }
                Err(e) => eprintln!("[native-share] input parse failed: {e}"),
            }
        });
    }

    // Poll thread: answers and remote ICE from the friend (JS side long-polls
    // the same mailbox on its side).
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        let poll_room = room.clone();
        let poll_webrtc = webrtc.clone();
        let app_for_poll = app.clone();
        thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match poll_room.poll() {
                    Ok(events) => {
                        for ev in events {
                            match ev {
                                Event::Answer { sdp } => {
                                    match set_remote_description(&poll_webrtc, &sdp) {
                                        Ok(()) => {
                                            let _ = poll_room.ack();
                                            emit_app(&app_for_poll, "answer", None);
                                        }
                                        Err(e) => eprintln!("[native-share] set-remote-description: {e}"),
                                    }
                                }
                                Event::Ice { mline, candidate } => {
                                    add_ice_candidate(&poll_webrtc, mline, &candidate);
                                }
                                Event::Ready { negotiation } => {
                                    eprintln!("[native-share] ready (negotiation {negotiation}) — a rejoining friend needs a fresh offer");
                                    emit_app(
                                        &app_for_poll,
                                        "ready",
                                        Some("someone is (re)joining — stop and share again to let them in".into()),
                                    );
                                }
                                Event::Bye => {
                                    emit_app(&app_for_poll, "disconnected", Some("friend left".into()));
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[native-share] poll error: {e}");
                        thread::sleep(std::time::Duration::from_secs(2));
                    }
                }
            }
        });
    }

    // Connection-state → events.
    {
        let stop_conn = stop.clone();
        let webrtc_notify = webrtc.clone();
        let app_for_conn = app.clone();
        webrtc_notify.clone().connect_notify(Some("connection-state"), move |_, _| {
            let state: gstreamer_webrtc::WebRTCPeerConnectionState =
                webrtc_notify.property("connection-state");
            eprintln!("[native-share] connection-state: {state:?}");
            if state == gstreamer_webrtc::WebRTCPeerConnectionState::Connected {
                emit_app(&app_for_conn, "connected", None);
            }
            if state == gstreamer_webrtc::WebRTCPeerConnectionState::Disconnected
                || state == gstreamer_webrtc::WebRTCPeerConnectionState::Failed
            {
                emit_app(&app_for_conn, "disconnected", Some("connection lost".into()));
            }
            let _ = &stop_conn; // captured for lifetime clarity
        });
    }

    share.start()?;

    *SHARE.lock().map_err(|_| "native share state poisoned")? = Some(NativeShare {
        share,
        stop,
        _portal: portal,
        code: code.clone(),
    });

    Ok(code)
}

fn set_remote_description(webrtc: &gstreamer::Element, sdp_text: &str) -> Result<(), String> {
    use gstreamer::glib::value::ToValue;

    let sdp = gstreamer_webrtc::gst_sdp::SDPMessage::parse_buffer(sdp_text.as_bytes())
        .map_err(|e| format!("parse answer SDP: {e}"))?;
    let answer = gstreamer_webrtc::WebRTCSessionDescription::new(
        gstreamer_webrtc::WebRTCSDPType::Answer,
        sdp,
    );
    let none_promise: Option<gstreamer::Promise> = None;
    let _ = webrtc.emit_by_name::<()>(
        "set-remote-description",
        &[&answer as &dyn ToValue, &none_promise as &dyn ToValue],
    );
    Ok(())
}

fn add_ice_candidate(webrtc: &gstreamer::Element, mline: u32, candidate: &str) {
    use gstreamer::glib::value::ToValue;

    let _ = webrtc.emit_by_name::<()>(
        "add-ice-candidate",
        &[&mline as &dyn ToValue, &candidate as &dyn ToValue],
    );
}

pub fn stop(_app: &tauri::AppHandle) {
    if let Ok(mut guard) = SHARE.lock() {
        if let Some(ns) = guard.take() {
            ns.set_null();
        }
    }
    if let Ok(mut guard) = CONTROL_CHANNEL.lock() {
        guard.take();
    }
}

pub fn running_code() -> Option<String> {
    SHARE.lock().ok()?.as_ref().map(|s| s.code.clone())
}
