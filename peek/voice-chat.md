# Two-way voice chat in Peek

Peek uses **two peer connections** under the same room code:

| Connection | Carries | Direction |
|---|---|---|
| Screen | your screen + optional desktop audio | host → viewer only |
| Voice | your physical microphone | host ↔ viewer |

You hear **the other person's** mic; Peek never plays your own mic back to
you. Each side mutes only its own mic. The voice path is direct
browser-to-browser WebRTC (DTLS-SRTP); the signaling server never carries or
records it.

## Turn it on

**Host (before hosting):**
1. Check **Enable two-way voice chat** in the audio options.
2. Click **Find microphones** (Firefox may ask for input permission — Peek
   stops the permission-check stream immediately).
3. Pick your **physical** mic from **Voice chat microphone**.
4. Click **Host a screen share** as usual and send the code.

**Viewer (before joining):**
1. Check **Enable voice chat** in the Join panel.
2. Click **Find microphones** and pick your physical mic.
3. Type the code and Join.

Voice works only when **both** sides opt in. If one side leaves it off, the
other sees a status message and the screen share continues normally.

## Kept separate from Steam Deck desktop audio

If the host enables **Share desktop audio → Firefox / Steam Deck — virtual
desktop input** and selects `Desktop_Audio`, Peek records that input's device
**name and ID** and removes it from every voice-mic picker (as well as any
`monitor of` / `.monitor` source). The virtual loopback can never become the
chat mic, and the chat mic is never added to the screen share. The two status
lines always say which device is doing which job.

## Feedback and privacy notes

- **Wear headphones.** Host mic → speakers → the `Desktop_Audio` monitor →
  back into the call is a feedback loop. Headphones do not fix the loopback
  by themselves; keep the captured output off your speakers.
- The voice mic uses echo cancellation/noise suppression; the desktop-audio
  input deliberately does not (it must stay a clean playback capture).
- **Mute** toggles the local mic track (`enabled = false`) — no renegotiation,
  nothing is sent while muted.
- If autoplay is blocked, use **🔊 Enable voice sound** to start playback.

## Verification status

Local two-tab tests with synthetic devices cover bidirectional voice, device
exclusion, mute, denial, retry and cleanup. Real Steam Deck / Firefox
hardware behavior still needs a manual check — see the caveat in
[steam-deck-audio.md](steam-deck-audio.md).
