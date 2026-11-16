//! xdg-desktop-portal ScreenCast → PipeWire fd + node id.
//!
//! On Wayland/Steam Deck this is the same dialog a browser shows for
//! `getDisplayMedia`. The session is returned with the fd so callers can
//! keep it alive exactly as long as the capture runs.

use std::os::fd::RawFd;

pub struct ScreencastPick {
    /// Raw pipewire remote fd (borrowed semantics; close with the owning
    /// `fd` field when the capture ends).
    pub fd: std::os::fd::OwnedFd,
    /// PipeWire node id for the streams picked by the user.
    pub node_id: u32,
    /// Keep the portal session alive: dropping it closes the portal stream.
    _session: ashpd::desktop::Session<ashpd::desktop::screencast::Screencast>,
}

impl ScreencastPick {
    pub fn fd_raw(&self) -> RawFd {
        use std::os::fd::AsRawFd;
        self.fd.as_raw_fd()
    }
}

/// Show the portal dialog; return the chosen stream's fd + node id.
pub async fn pick_screencast() -> Result<ScreencastPick, String> {
    use ashpd::desktop::{
        PersistMode,
        screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType, StartCastOptions},
    };

    let proxy = Screencast::new()
        .await
        .map_err(|e| format!("portal connect: {e}"))?;
    let session = proxy
        .create_session(Default::default())
        .await
        .map_err(|e| format!("create_session: {e}"))?;

    proxy
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_sources(SourceType::MONITOR | SourceType::WINDOW)
                .set_cursor_mode(CursorMode::EMBEDDED)
                .set_multiple(false)
                .set_persist_mode(PersistMode::DoNot),
        )
        .await
        .map_err(|e| format!("select_sources: {e}"))?
        .response()
        .map_err(|e| format!("select_sources response: {e}"))?;

    let response = proxy
        .start(&session, None, StartCastOptions::default())
        .await
        .map_err(|e| format!("start screencast (did the dialog open?): {e}"))?
        .response()
        .map_err(|e| format!("start screencast response: {e}"))?;

    let stream = response
        .streams()
        .first()
        .ok_or("portal returned no streams")?;
    let node_id = stream.pipe_wire_node_id();

    let fd = proxy
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(|e| format!("open_pipe_wire_remote: {e}"))?;

    Ok(ScreencastPick { fd, node_id, _session: session })
}
