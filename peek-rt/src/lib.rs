//! Peek Remote RT — GStreamer-native screen share + WebRTC transport for the
//! Steam Deck / Wayland. The webview does no media work at all.
//!
//! Path: portal (Screencast) → `pipewiresrc` → `x264enc` → `rtph264pay`
//! → `webrtcbin` → the peek-signal mailbox. Input arrives back over the
//! `peek-remote-control` data channel and goes straight to uinput.

use std::sync::Arc;

pub mod mailbox;
#[cfg(target_os = "linux")]
pub mod portal;
pub mod input;

use gstreamer as gst;
use gstreamer::glib::value::ToValue;
use gstreamer::prelude::*;

/// SDP offer lands here once webrtcbin has negotiated one.
/// Called from a GStreamer thread — must be `Send + Sync`.
pub type OfferHandler = Arc<dyn Fn(String) + Send + Sync>;
/// Trickling ICE candidate: (sdp_mline_index, candidate).
pub type IceHandler = Arc<dyn Fn(u32, String) + Send + Sync>;

/// Install the offer + ICE handlers on a webrtcbin element.
///
/// Wires the standard GStreamer WebRTC dance:
///   on-negotiation-needed → create-offer (promise) → set-local-description
///   on-ice-candidate      → IceHandler (caller posts it to the mailbox)
pub fn install_handlers<F, G>(webrtc: &gst::Element, on_offer: F, on_ice: G)
where
    F: Fn(String) + Send + Sync + 'static,
    G: Fn(u32, String) + Send + Sync + 'static,
{
    let on_offer = Arc::new(on_offer);
    let on_ice = Arc::new(on_ice);

    let none_structure: Option<gst::Structure> = None;
    webrtc.connect("on-negotiation-needed", false, move |values| {
        let webrtc = values[0].get::<gst::Element>().expect("webrtcbin element");
        let app_webrtc = webrtc.clone();
        let on_offer = on_offer.clone();

        let promise = gst::Promise::with_change_func(move |reply| {
            let reply = match reply {
                Ok(Some(reply)) => reply,
                Ok(None) => {
                    eprintln!("offer promise: webrtcbin reply structure was null");
                    return;
                }
                Err(err) => {
                    eprintln!("offer promise failed: {err:?}");
                    return;
                }
            };
            let offer = match reply.value("offer") {
                Ok(v) => match v.get::<gstreamer_webrtc::WebRTCSessionDescription>() {
                    Ok(o) => o,
                    Err(e) => {
                        eprintln!("offer value: not a WebRTCSessionDescription: {e:?}");
                        return;
                    }
                },
                Err(e) => {
                    eprintln!("offer promise reply: no 'offer' field: {e:?}");
                    return;
                }
            };

            let none_promise: Option<gst::Promise> = None;
            let _ = app_webrtc.emit_by_name::<()>(
                "set-local-description",
                &[&offer as &dyn ToValue, &none_promise as &dyn ToValue],
            );

            let sdp = offer.sdp().as_text().unwrap_or_else(|_| String::new());
            on_offer(sdp);
        });

        let _ = webrtc.emit_by_name::<()>(
            "create-offer",
            &[&none_structure as &dyn ToValue, &promise as &dyn ToValue],
        );
        None
    });

    webrtc.connect("on-ice-candidate", false, move |values| {
        let mlineindex = values[1].get::<u32>().unwrap_or(0);
        let candidate = values[2].get::<String>().unwrap_or_else(|_| String::new());
        if !candidate.is_empty() {
            on_ice(mlineindex, candidate);
        }
        None
    });
}

/// Wire an input handler onto a data channel — called with each string message
/// the friend sends over the control channel.
pub fn install_input_handler<H>(
    channel: &gstreamer_webrtc::WebRTCDataChannel,
    on_message: H,
) where
    H: Fn(String) + Send + Sync + 'static,
{
    channel.connect_on_message_string(move |_channel, payload| {
        if let Some(payload) = payload {
            on_message(payload.to_owned());
        }
    });
}

/// A built (PAUSED-able) screen-share pipeline.
pub struct PeekShare {
    pipeline: gst::Pipeline,
    webrtc: gst::Element,
}

impl PeekShare {
    /// Live capture: xdg-desktop-portal's PipeWire fd+node id (Steam Deck path).
    pub fn pipewire(fd: std::os::fd::RawFd, node_id: u32) -> Result<Self, String> {
        Self::build(&format!("pipewiresrc fd={fd} path={node_id} do-timestamp=true"))
    }

    /// Synthetic source — only for machines without a portal (dev testing).
    pub fn test_pattern() -> Result<Self, String> {
        Self::build("videotestsrc is-live=true pattern=ball num-buffers=-1")
    }

    fn build(src: &str) -> Result<Self, String> {
        gst::init().map_err(|e| format!("gst init: {e}"))?;
        let launch = format!(
            "{src} ! videoconvert \
             ! x264enc name=enc tune=zerolatency bitrate=1500 key-int-max=15 \
             ! rtph264pay pt=96 config-interval=-1 perfect-rtptime=true \
             ! webrtcbin bundle-policy=max-bundle name=webrtcbin \
               stun-server=stun:stun.l.google.com:19302"
        );

        let pipeline = gst::parse::launch(&launch)
            .map_err(|e| format!("pipeline parse: {e}\nlaunch: {launch}"))?
            .dynamic_cast::<gst::Pipeline>()
            .map_err(|_| "launch did not produce a Pipeline".to_string())?;

        let webrtc = pipeline
            .iterate_elements()
            .find(|e| e.name() == "webrtcbin")
            .ok_or("webrtcbin missing from pipeline")?;

        Ok(Self { pipeline, webrtc })
    }

    pub fn pipeline(&self) -> &gst::Pipeline {
        &self.pipeline
    }
    pub fn webrtc(&self) -> &gst::Element {
        &self.webrtc
    }

    /// webrtcbin starts closed by design ("we start off closed until we move
    /// to READY"), so data channels can only exist once the pipeline left
    /// NULL. Callers must PAUSE first, then create, then PLAY.
    pub fn prime_paused(&self) -> Result<(), String> {
        self.pipeline
            .set_state(gstreamer::State::Paused)
            .map_err(|e| format!("prime PAUSED: {e:?}"))?;
        Ok(())
    }

    /// Create the `peek-remote-control` channel. Requires PAUSED state.
    pub fn create_control_channel(&self) -> Result<gstreamer_webrtc::WebRTCDataChannel, String> {
        use gstreamer::glib::value::ToValue;

        let label = "peek-remote-control";
        let none_structure: Option<gst::Structure> = None;
        let channel: Option<gstreamer_webrtc::WebRTCDataChannel> = self.webrtc.emit_by_name(
            "create-data-channel",
            &[&label as &dyn ToValue, &none_structure as &dyn ToValue],
        );
        channel.ok_or_else(|| "webrtcbin returned no data channel (pipeline must be PAUSED first)".to_string())
    }

    pub fn start(&self) -> Result<(), String> {
        self.pipeline
            .set_state(gstreamer::State::Playing)
            .map_err(|e| format!("set PLAYING: {e:?}"))?;
        Ok(())
    }

    pub fn stop(&self) {
        let _ = self.pipeline.set_state(gstreamer::State::Null);
    }
}

impl Drop for PeekShare {
    fn drop(&mut self) {
        self.stop();
    }
}
