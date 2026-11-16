#!/usr/bin/env bash
# ============================================================
# Peek Remote — one-shot installer (Linux / Steam Deck / Plasma)
#
#   curl -fsSL https://gaster4432.github.io/peek-remote/install.sh | bash
#
# What it does, in order:
#   1. Ask for your sudo password (one time, for the uinput rule only)
#   2. Detect SteamOS read-only state and handle it correctly:
#        - already writable  -> use as-is, leave it writable
#        - read-only enabled -> disable it for this install, re-enable at the end
#        - not SteamOS       -> treat as a normal Linux box, no mode changes
#   3. Install a /dev/uinput udev rule (TAG+="uaccess", ACL for your user,
#      no group changes, no logout, no reboot, no re-login)
#   4. Verify the access actually landed (getfacl /dev/uinput)
#   5. Download the AppImage + icon into your home dir / $HOME, chmod +x
#   6. Write a launcher entry (~/.local/share/applications/peek-remote.desktop)
#   7. Refresh desktop caches / launcher index
#
# No root beyond the sudo prompt. No reboot. Nothing in /usr (Deck stays sane).
# ============================================================
set -euo pipefail

APP_DIR="${HOME}/Applications"
ICON_DIR="${HOME}/.local/share/icons"
MENU_DIR="${HOME}/.local/share/applications"
APPIMAGE="${APP_DIR}/peek-remote.AppImage"
ICON="${ICON_DIR}/peek-remote.png"
DESKTOP="${MENU_DIR}/peek-remote.desktop"
UDEV_RULE=/etc/udev/rules.d/60-uinput.rules

APPIMAGE_URL="https://github.com/gaster4432/gaster4432.github.io/releases/latest/download/peek-remote.AppImage"
ICON_URL="https://raw.githubusercontent.com/gaster4432/gaster4432.github.io/main/peek-remote/src-tauri/icons/icon.png"

CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
log()  { printf '%s==>%s %s\n'  "$CYAN"   "$RESET" "$*"; }
warn() { printf '%sWARNING:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n'  "$RED"    "$RESET" "$*" >&2; exit 1; }

echo
echo "  Peek Remote installer"
echo "  --------------------"
echo "  This needs sudo for ONE thing: the /dev/uinput permission rule"
echo "  (so remote keyboard/mouse control can work). Everything else"
echo "  goes into your home directory."
echo

command -v curl >/dev/null || die "curl not found — install curl and re-run"
command -v getfacl >/dev/null || warn "getfacl not found; will verify with read/write test instead"

log "asking for your sudo password…"
sudo -v

# ── 1. SteamOS read-only handling ─────────────────────────
readonly_state="not-steamos"
if command -v steamos-readonly >/dev/null 2>&1; then
  status_out="$(steamos-readonly status 2>&1 || true)"
  if grep -qi 'writable' <<<"$status_out"; then
    readonly_state="writable"
  elif grep -qiE 'read.?only|readonly' <<<"$status_out"; then
    readonly_state="readonly"
  else
    # Unknown output: assume read-only so we restore it afterwards.
    readonly_state="readonly"
    warn "unrecognized steamos-readonly status: '$status_out' — will disable + re-enable read-only"
  fi
fi
log "SteamOS read-only status: ${readonly_state}"

restored=0
case "$readonly_state" in
  readonly)
    log "read-only is enabled — temporarily disabling it (it will be re-enabled)…"
    sudo steamos-readonly disable
    restored=1
    ;;
  writable)
    log "already writable — using as-is, will NOT re-enable read-only"
    ;;
  not-steamos)
    log "not SteamOS — installing on a normal Linux path (no mode changes)"
    ;;
esac

# ── 2. uinput permission (uaccess, no groups) ───────────────
log "installing udev rule for /dev/uinput (uaccess ACL, no group changes)…"
echo 'KERNEL=="uinput", TAG+="uaccess", OPTIONS+="static_node=uinput"' | sudo tee "$UDEV_RULE" >/dev/null
sudo modprobe uinput 2>/dev/null || warn "modprobe uinput failed — keyboard/mouse control may not work"
sudo udevadm control --reload
sudo udevadm trigger
log "udev rule installed and triggered"

# ── 3. restore read-only if we touched it ─────────────────
if [ "$restored" = "1" ]; then
  log "re-enabling SteamOS read-only…"
  sudo steamos-readonly enable
fi

# ── 4. verify ─────────────────────────────────────────────
if command -v getfacl >/dev/null; then
  if getfacl /dev/uinput 2>/dev/null | grep -E "user:${USER}:" >/dev/null; then
    log "verified: /dev/uinput grants ${USER} read/write (ACL)"
  else
    warn "could not confirm the ACL on /dev/uinput — audio/video will work, input may not"
  fi
else
  if [ -r /dev/uinput ] && [ -w /dev/uinput ]; then
    log "verified: /dev/uinput is read/write for ${USER}"
  else
    warn "could not confirm /dev/uinput access — audio/video will work, input may not"
  fi
fi

# ── 5. download app + icon ────────────────────────────────
mkdir -p "$APP_DIR" "$ICON_DIR" "$MENU_DIR"
log "downloading Peek Remote AppImage (~104 MB)…"
curl -fL --retry 3 --retry-delay 2 -o "$APPIMAGE" "$APPIMAGE_URL"
chmod +x "$APPIMAGE"
curl -fL --retry 3 --retry-delay 2 -o "$ICON" "$ICON_URL" || warn "icon download failed — launcher will use a generic icon"

# ── 6. launcher entry ─────────────────────────────────────
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Peek Remote
Comment=Share your screen and hand over keyboard and mouse
# APPIMAGE_EXTRACT_AND_RUN makes this work even on systems without FUSE.
# Remove the env wrapper if you prefer a native AppImage mount.
Exec=env APPIMAGE_EXTRACT_AND_RUN=1 ${APPIMAGE}
Icon=${ICON}
Categories=Utility;Network;
Terminal=false
StartupWMClass=peek-remote
EOF
chmod 644 "$DESKTOP"
log "launcher entry written to ${DESKTOP}"

update-desktop-database "$MENU_DIR" 2>/dev/null || true
kbuildsycoca6 2>/dev/null || kbuildsycoca5 2>/dev/null || true

echo
printf '%s✔ Done.%s Search "Peek Remote" in the application launcher.\n' "$GREEN" "$RESET"
echo
echo "  Next: launch it → Share this screen → click Allow control when"
echo "  you want to be remote-controlled. Your friend opens the app,"
echo "  enters your 6-character code, Connect, Take control."
echo "  Ctrl+Alt+Q anywhere cuts control instantly."
echo
