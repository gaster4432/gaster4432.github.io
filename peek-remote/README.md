# Peek Remote

Remote screen share **plus keyboard/mouse control** for Windows and Linux (Steam Deck),
built on the same Peek v4 signaling mailbox (`peek-node`). **No server changes** — the input
channel is an `RTCDataChannel` created inside the same WebRTC offer SDP, and the mailbox
only ever carries the offer/answer/ICE.

- **Host (share)**: `getDisplayMedia` video → viewer; receives control input and injects it locally
- **Viewer (join)**: watches the screen; mouse/keyboard captured relative to the video are forwarded
- **Consent**: nothing injects until the host clicks *Allow control*. The gate is an
  `AtomicBool` in Rust (`src-tauri/src/main.rs`), not a frontend variable — a page bug cannot bypass it.
- **Kill switch (Windows)**: `Ctrl+Alt+Q` anywhere disables control instantly (global hotkey via
  `RegisterHotKey`, no plugin). On Linux the always-on-top window carries the STOP button;
  Wayland offers no compositor-independent global grab.

## Status — what is verified right now

| Piece | State |
|---|---|
| v4 mailbox protocol client (JS, same as `peek/`) | compiles, logic ported 1:1 |
| WebRTC + RTCDataChannel in the Tauri webview | compiles |
| Windows input injection (SendInput, `windows` crate) | **compiles clean**; not run against a live machine yet |
| Linux input injection (`/dev/uinput` via `evdev`) | **compiles clean against `x86_64-unknown-linux-gnu`**; needs `/dev/uinput` permissions at runtime |
| Windows app (`cargo check`) | 0 errors, 0 warnings |
| Mac/other platforms | unsupported (no backend) |
| Steam Deck screen capture in WebKitGTK (Wayland) | **unknown** — see "Wayland reality check" |

This has **never been run end-to-end yet**. Treat every layer above the compile step as untested.

## Desktop audio (the AppImage is not a browser)

Audio is **not** routed through the browser's `getDisplayMedia` path. The native helper
owns it, exactly as a desktop app should:

**Linux** — before the peer connection is created, the Rust side loads a hidden
`module-remap-source` on the default sink's monitor:

```
pactl load-module module-remap-source \
  master=$(pactl get-default-sink).monitor \
  source_name=peek_remote_desktop_audio \
  source_properties=device.description="Peek Remote Audio"
```

That is a virtual input that carries **exactly the desktop mix and nothing else** — the
"hidden device" design. The webview captures it via `getUserMedia` and forwards it as the
audio track. Loading is idempotent; the module is unloaded on quit (`audio_teardown` on
dispose + on window close). If the load fails (no pactl / no PipeWire server), the app
tries the browser display-audio fallback, and if that yields nothing it shares **video
only** — the chip in the host UI always says which path it got.

**Windows** — unimplemented on purpose this pass. WASAPI loopback (`AUDCLNT_STREAMFLAGS_LOOPBACK`)
is the correct native backend; the "hidden device" trick is impossible without shipping a
kernel driver, which we will not do. Best effort today: browser display-audio from WebView2.
Track the phase-2 note in the README.

| Audio path | Linux | Windows |
|---|---|---|
| Hidden remap-source (native helper) | ✔ built — needs pactl + PipeWire/Pulse compat at runtime | ✗ impossible without a driver |
| Native WASAPI loopback | n/a | ✗ phase 2 |
| Browser display-audio (fallback) | ✔ attempted | ✔ attempted |
| Video-only degrade | ✔ automatic with chip | ✔ automatic with chip |

Honest status: the hidden-device path **compiles and runs on the native side**, but the
WebKitGTK `getUserMedia` capture is unverified — mic capture behavior in a Tauri webview
varies. If it fails on your Deck, the chip will say so and video survives regardless.
## Wayland reality check (Steam Deck)

- Capture: the webview path depends on WebKitGTK supporting `getDisplayMedia`. If it does not,
  the correct path is **PipeWire + xdg-desktop-portal ScreenCast** in Rust (`ashpd` + `pipewire`),
  which is a real chunk of work that is NOT in this build yet. If `getDisplayMedia` fails on your
  deck, that is why — it is expected, and the portal backend is phase 2.
- Gaming Mode (gamescope) has no portal and no input injection hook — **Desktop Mode only**.
- Input: uinput works under Wayland regardless of compositor (that is its whole point), but the
  app must reach `/dev/uinput`. Either add a udev rule + `uinput` group, or run input-privileged.
  `peek-remote` does not escalate privileges by itself — by design.
- Absolute mouse: normalized 0..65535 axis, compositor scales it. Works on X11 and KDE Plasma/Wayland
  in the common case; verify on your Deck.

## Build & run on Windows

```powershell
winget install Rustlang.Rustup   # if missing
cd peek-remote
npm install
npm run tauri dev                # runs the app with hot reload
npm run tauri build              # installer build (icons present; bundle targets not configured yet)
```

## Build & run on Steam Deck / Linux (no system installs, everything in $HOME)

SteamOS keeps `/usr` read-only, so nothing is installed system-wide. The app is
built inside a **Distrobox** (a container in `$HOME`), which produces an
**AppImage** — one self-contained file with all its libraries bundled, dropped
anywhere you like, zero changes to the read-only OS.

```sh
# 1. one-time setup on the Deck (Desktop Mode)
sudo steamos-readonly disable            # only to install distrobox+toolbox once; re-enable after
sudo pacman -S --needed distrobox
sudo steamos-readonly enable             # back to read-only

# 2. a builder container in $HOME (does not touch /usr)
distrobox create --name peek-build --image archlinux
distrobox enter peek-build
sudo pacman -S --needed base-devel rustup nodejs npm webkit2gtk-4.1 patchelf fuse2
rustup default stable
exit

# 3. build the AppImage (still all inside $HOME)
distrobox enter peek-build
cd ~/gaster4432.github.io/peek-remote
npm install
npm run tauri build -- --bundles appimage
#   → src-tauri/target/release/bundle/appimage/Peek Remote_0.1.0_amd64.AppImage
exit

# 4. install it to your home — no root, no pacman, /usr untouched
mkdir -p ~/Applications
mv "src-tauri/target/release/bundle/appimage/Peek Remote_0.1.0_amd64.AppImage" ~/Applications/peek-remote
chmod +x ~/Applications/peek-remote
~/Applications/peek-remote               # or add a .desktop shortcut in ~/.local/share/applications
```

If the Deck's FUSE support is missing for AppImages, run it with:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ~/Applications/peek-remote
```

uinput for input injection: the app cannot self-escalate (by design). Either add a
`/etc/udev/rules.d/60-uinput.rules`+`uinput` group (requires `steamos-readonly disable`
once) or grant input through a `sudo` wrapper — the capture/UI half works without it.

`npm run tauri build` on the Deck reads `src-tauri/tauri.linux.conf.json` and produces
the AppImage target automatically. On Windows, the same command builds the NSIS installer
(`webviewInstallMode: embedBootstrapper` — the installer carries the WebView2 bootstrapper).

## Quick alternative: plain `tauri dev` on the Deck

```sh
cd peek-remote && npm install && npm run tauri dev
```

(requires webkit2gtk + rust to exist, so the Distrobox path above is preferred on stock SteamOS.)

## Protocol compatibility

Same mailbox as `peek-node/mailbox.js` (v4): `POST /room/create`, `GET/POST /room`, long-poll,
`offer/answer/ice/ready/leave/ack/close`. The data channel label is `peek-remote-control`;
the mailbox cannot see it because it travels inside the SDP. **No changes to peek-node or
peek-signal.duckdns.org are required.**

## Safety model (and its limits)

- Host must explicitly enable control per session; it starts disabled and is force-disabled on share stop/dispose.
- Host window is always-on-top so the STOP button stays reachable.
- Viewer key events are forwarded to the host's real keyboard — treat "allow control" like giving
  your password away while it is on. Only enable it with someone you trust, only while you are watching.
- No encryption beyond WebRTC's mandatory DTLS-SRTP (same as Peek); that is transport encryption,
  not consent — consent is the toggle.

## What is deliberately not here yet

- Native PipeWire/portal capture for Linux/Wayland (phase 2; webview path tried first)
- Audio capture
- Clipboard sharing, file transfer, multi-monitor selection UI
- Real packaging (AppImage / .msi) — `bundle.active` is false; `tauri build` needs targets set
- Code review by anyone but me and one compiler — read `src-tauri/src/` before running it
