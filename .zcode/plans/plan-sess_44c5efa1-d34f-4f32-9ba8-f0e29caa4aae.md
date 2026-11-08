Peek — audio hardening + Firefox warm-up (all in peek/index.html; no signaling changes)

CONTEXT
- Research verdict on Chrome for the Deck: installing Chrome helps WebRTC reliability (joiner side strictly better; eager ICE init removes the "friend joins first" quirk), BUT audio capture on Linux stays limited — Flatpak Chrome can't capture any getDisplayMedia audio, native Linux Chrome only captures TAB audio (system audio = PipeWire loopback hacks, known-buggy), Firefox Linux = none. So: recommend Chrome on the Deck for viewing; the audio flick matters on the Windows host, which already fully supports it. Deck-as-host = tab audio only, best via native Chrome + --ozone-platform-hint=auto.
- Regardless of browser, the client code gets hardened so audio works everywhere it CAN work.

CHANGES (peek/index.html only)
1. Joiner: replace `srcObject = e.streams[0]` with manual assembly — one `remoteStream = new MediaStream()`; ontrack adds each track to it; srcObject attached once. Removes the Firefox↔Chrome msid-association failure class (the most likely reason audio/video silently never appears on the Deck).
2. Joiner: explicit `video.muted = false; video.play()` after attach; on autoplay-policy rejection show a "▶ tap for sound" overlay on the video (click → play). Overlay auto-hides on success. New `#tapOverlay` div + CSS in the existing `.vid-wrap`.
3. Joiner teardown: reset `remoteStream`, hide overlay.
4. Host: add `systemAudio: 'include'` hint to getDisplayMedia (Windows Chrome will offer system audio; ignored elsewhere). After capture, show one status line (`#hostAudioNote`): "🔊 audio is being shared" or "🔇 no audio track — this browser/platform didn't offer one" so Linux/Firefox hosts aren't surprised.
5. Firefox warm-up: `warmUpWebRTC()` on page load — two RTCPeerConnections wired in an in-page loopback (offer→answer→local candidate exchange), close on `connected` or 4s timeout, silent try/catch, once per load. Primes the lazily-initialized ICE/DTLS stack that makes the first Firefox join flaky. No server involvement.

VERIFICATION
- Extract inline script → `new Function()` syntax check.
- Re-run the mailbox handshake test (signaling untouched — proves nothing regressed).
- User hardware test (can't automate): Deck joins a Windows-Chrome-hosted share → video + audio play (or tap-for-sound overlay if autoplay blocked); second join attempt on a fresh Firefox page works without the friend joining first.