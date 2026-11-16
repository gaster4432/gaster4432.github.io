// Probe: does the offer path work end to end in this machine?
// Builds the pipeline, installs the negotiation handlers, sets PLAYING,
// and exits as soon as webrtcbin produces the offer SDP.

use gstreamer as gst;
use gstreamer::glib;
use gstreamer::prelude::*;

fn main() {
    gst::init().expect("gst init");

    let pipeline = gst::parse::launch(
        "videotestsrc is-live=true pattern=ball num-buffers=-1 ! videoconvert \
         ! x264enc name=enc tune=zerolatency bitrate=1500 key-int-max=15 \
         ! rtph264pay pt=96 config-interval=-1 perfect-rtptime=true \
         ! webrtcbin bundle-policy=max-bundle name=webrtcbin \
           stun-server=stun:stun.l.google.com:19302",
    )
    .expect("pipeline parse")
    .dynamic_cast::<gst::Pipeline>()
    .expect("not a pipeline");

    let webrtc = pipeline
        .iterate_elements()
        .find(|e| e.name() == "webrtcbin")
        .expect("webrtcbin missing");

    peek_rt::install_handlers(
        &webrtc,
        |sdp| {
            println!("=== SDP OFFER ===\n{sdp}\n=== END OFFER ===");
            std::process::exit(0);
        },
        |mline, cand| {
            eprintln!("ICE[{mline}]: {cand}");
        },
    );

    pipeline.set_state(gstreamer::State::Playing).expect("set PLAYING");

    let ctx = glib::MainContext::default();
    let _guard = ctx.acquire().expect("acquire main context");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while std::time::Instant::now() < deadline {
        ctx.iteration(false);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    eprintln!("TIMEOUT — no SDP offer from webrtcbin after 8s");
    std::process::exit(1);
}
