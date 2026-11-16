// peek-rt-host: native GStreamer screen-share host.
//
// Without arguments: shows the Wayland portal picker and captures the
// selected screen (Steam Deck path).
// `--test-pattern`: synthetic ball source (machines without a portal).
// `PEEK_CONSENT=1`: input events from the friend are forwarded to uinput
// (needs /dev/uinput; off by default).
//
// Flow: create room → portal/test pipeline → prime PAUSED → create control
// channel → PLAYING → offer → mailbox → answer/ICE → CONNECTED.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;

use peek_rt::mailbox::{self, Event};
use peek_rt::PeekShare;

fn set_remote_description(webrtc: &gst::Element, sdp_text: &str) -> Result<(), String> {
    use gstreamer::glib::value::ToValue;

    let sdp = gstreamer_webrtc::gst_sdp::SDPMessage::parse_buffer(sdp_text.as_bytes())
        .map_err(|e| format!("parse answer SDP: {e}"))?;
    let answer = gstreamer_webrtc::WebRTCSessionDescription::new(
        gstreamer_webrtc::WebRTCSDPType::Answer,
        sdp,
    );
    let none_promise: Option<gst::Promise> = None;
    let _ = webrtc.emit_by_name::<()>(
        "set-remote-description",
        &[&answer as &dyn ToValue, &none_promise as &dyn ToValue],
    );
    Ok(())
}

fn add_ice_candidate(webrtc: &gst::Element, mline: u32, candidate: &str) {
    use gstreamer::glib::value::ToValue;

    let _ = webrtc.emit_by_name::<()>(
        "add-ice-candidate",
        &[&mline as &dyn ToValue, &candidate as &dyn ToValue],
    );
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let use_pattern = std::env::args().any(|a| a == "--test-pattern");

    let sid = format!("host-{}", std::process::id());
    let room = mailbox::Room::create(&sid).unwrap_or_else(|e| {
        eprintln!("failed to create mailbox room: {e}");
        std::process::exit(1);
    });

    println!();
    println!("========================================");
    println!("  PEEK CODE: {code}", code = room.code);
    println!("  friend types that at the Peek Remote page");
    println!("========================================");
    println!();

    let room = Arc::new(room);

    // GStreamer source: portal screencast on Linux/Wayland, else test pattern.
    // The portal pick (fd + session) must outlive the pipeline — hold it.
    let (share, _portal_pick) = if use_pattern {
        eprintln!("using synthetic test pattern source");
        let share = PeekShare::test_pattern().unwrap_or_else(|e| {
            eprintln!("failed to build pipeline: {e}");
            std::process::exit(1);
        });
        (share, None)
    } else {
        #[cfg(target_os = "linux")]
        {
            eprintln!("asking the portal what to share (system dialog)…");
            let pick = match peek_rt::portal::pick_screencast().await {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("portal pick failed: {e}");
                    std::process::exit(1);
                }
            };
            eprintln!("portal picked node {} — building PipeWire pipeline", pick.node_id);
            let fd = pick.fd_raw();
            let share = PeekShare::pipewire(fd, pick.node_id).unwrap_or_else(|e| {
                eprintln!("failed to build pipeline: {e}");
                std::process::exit(1);
            });
            (share, Some(pick))
        }
        #[cfg(not(target_os = "linux"))]
        {
            eprintln!("portal capture is only available on Linux (Steam Deck). Use --test-pattern for a synthetic source.");
            std::process::exit(1);
        }
    };

    let webrtc = share.webrtc().clone();

    peek_rt::install_handlers(
        &webrtc,
        {
            let room = room.clone();
            move |sdp: String| {
                eprintln!("offer created ({len} bytes)", len = sdp.len());
                if let Err(e) = room.offer(&sdp) {
                    eprintln!("FAILED to post offer to mailbox: {e}");
                    return;
                }
                eprintln!("offer posted — waiting for friend to join");
            }
        },
        {
            let room = room.clone();
            move |mline, candidate| {
                if let Err(e) = room.ice(mline, &candidate) {
                    eprintln!("failed to post ICE candidate: {e}");
                }
            }
        },
    );

    // The control channel exists before PLAYING so negotiation includes it.
    // webrtcbin only opens after leaving NULL, hence prime → create → play.
    share.prime_paused().unwrap_or_else(|e| {
        eprintln!("pipeline failed to prime: {e}");
        std::process::exit(1);
    });
    let channel = share.create_control_channel().unwrap_or_else(|e| {
        eprintln!("failed to create control channel: {e}");
        std::process::exit(1);
    });

    let consent = std::env::var("PEEK_CONSENT").map(|v| v == "1").unwrap_or(false);
    eprintln!(
        "input gate: {}",
        if consent {
            "OPEN — friend's mouse/keys will reach this machine"
        } else {
            "closed — input events are logged and dropped"
        }
    );
    peek_rt::install_input_handler(&channel, move |msg| {
        if !consent {
            eprintln!("input (gated, not applied): {msg}");
            return;
        }
        match peek_rt::input::parse_msg_json(&msg) {
            Ok(event) => match peek_rt::input::inject(&event) {
                Ok(()) => eprintln!("injected {}", kind(&event)),
                Err(e) => eprintln!("inject failed: {e}"),
            },
            Err(e) => eprintln!("input parse failed: {e}"),
        }
    });

    // Poll thread: the browser will join, answer, and trickle ICE candidates.
    let poll_room = room.clone();
    let poll_webrtc = webrtc.clone();
    thread::spawn(move || loop {
        match poll_room.poll() {
            Ok(events) => {
                for ev in events {
                    match ev {
                        Event::Answer { sdp } => {
                            eprintln!("answer received ({len} bytes)", len = sdp.len());
                            match set_remote_description(&poll_webrtc, &sdp) {
                                Ok(()) => {
                                    eprintln!("set-remote-description OK");
                                    let _ = poll_room.ack();
                                }
                                Err(e) => eprintln!("set-remote-description failed: {e}"),
                            }
                        }
                        Event::Ice { mline, candidate } => {
                            add_ice_candidate(&poll_webrtc, mline, &candidate);
                            eprintln!("remote ICE candidate added");
                        }
                        Event::Ready { negotiation } => {
                            eprintln!("READY (negotiation {negotiation}) — re-negotiation not implemented yet")
                        }
                        Event::Bye => eprintln!("bye — friend left"),
                    }
                }
            }
            Err(e) => {
                eprintln!("poll error: {e} — retrying");
                thread::sleep(Duration::from_secs(2));
            }
        }
    });

    // Connection-state transitions: print them, and exit 0 on Connected.
    let connected = Arc::new(Mutex::new(false));
    {
        let connected = connected.clone();
        let webrtc_for_notify = webrtc.clone();
        webrtc_for_notify.clone().connect_notify(Some("connection-state"), move |_, _| {
            let state: gstreamer_webrtc::WebRTCPeerConnectionState =
                webrtc_for_notify.property("connection-state");
            eprintln!("connection-state: {state:?}");
            if state == gstreamer_webrtc::WebRTCPeerConnectionState::Connected {
                *connected.lock().unwrap() = true;
            }
        });
    }

    share.start().unwrap_or_else(|e| {
        eprintln!("pipeline failed to start: {e}");
        std::process::exit(1);
    });
    eprintln!("pipeline PLAYING");

    // Keep the process alive while the friend watches; exit once configured.
    let ctx = gstreamer::glib::MainContext::default();
    let _guard = ctx.acquire().expect("acquire main context");
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    while std::time::Instant::now() < deadline {
        ctx.iteration(false);
        std::thread::sleep(Duration::from_millis(20));
        if *connected.lock().unwrap() {
            println!("CONNECTION-ESTABLISHED");
            let keepalive = std::time::Instant::now() + Duration::from_secs(120);
            while std::time::Instant::now() < keepalive {
                ctx.iteration(false);
                std::thread::sleep(Duration::from_millis(20));
            }
            println!("done — exiting after keepalive");
            std::process::exit(0);
        }
    }
    eprintln!("TIMEOUT: no connection established after 600s");
    std::process::exit(2);
}

fn kind(event: &peek_rt::input::InjectEvent) -> &'static str {
    match event {
        peek_rt::input::InjectEvent::MouseMove { .. } => "mousemove",
        peek_rt::input::InjectEvent::MouseDown { .. } => "mousedown",
        peek_rt::input::InjectEvent::MouseUp { .. } => "mouseup",
        peek_rt::input::InjectEvent::Wheel { .. } => "wheel",
        peek_rt::input::InjectEvent::KeyDown { .. } => "keydown",
        peek_rt::input::InjectEvent::KeyUp { .. } => "keyup",
    }
}
