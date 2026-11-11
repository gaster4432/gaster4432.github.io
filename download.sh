#!/usr/bin/env bash
# Linux equivalent of the RecFlare download.bat (2025 patch flow)
# After setup, optionally adds a non-Steam Steam library shortcut for RecRoomScreen.bat
# (launched via Proton). Requires Steam to be closed for the shortcut step, then restart Steam.

set -euo pipefail

PATCH_VERSION="v0.0.8"

# Always install into ~/Games/RecFlare (create if missing).
# Keeps a one-shot curl|bash run from dumping files into $HOME or cwd.
INSTALL_DIR="${HOME}/Games/RecFlare"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
SCRIPT_DIR="$INSTALL_DIR"

# Colors
CYAN='\033[96m'
GREEN='\033[92m'
RED='\033[91m'
YELLOW='\033[93m'
RESET='\033[0m'

error() {
  echo
  echo -e "${RED}*** FAILED (exit code $?) - stopping. ***${RESET}"
  exit 1
}
trap error ERR

# --- helpers ---
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo -e "${RED}Required command not found: $1${RESET}"
    echo "Install it and re-run."
    exit 1
  }
}

need_cmd curl
need_cmd tar
need_cmd md5sum
need_cmd unzip  # for DepotDownloader zip; tar may also work depending on version

# --- Steam path detection (for non-Steam shortcut) ---
find_steam_userdata() {
  local candidates=(
    "$HOME/.steam/steam/userdata"
    "$HOME/.local/share/Steam/userdata"
    "$HOME/.var/app/com.valvesoftware.Steam/data/Steam/userdata"
  )
  for d in "${candidates[@]}"; do
    if [[ -d "$d" ]]; then
      echo "$d"
      return 0
    fi
  done
  return 1
}

find_steam_userid() {
  local userdata
  userdata=$(find_steam_userdata) || return 1
  # Prefer the most recently modified numeric userdata dir (skip "0" / anonymous)
  local best=""
  local best_mtime=0
  for d in "$userdata"/*/; do
    local base
    base=$(basename "$d")
    [[ "$base" =~ ^[0-9]+$ ]] || continue
    [[ "$base" == "0" ]] && continue
    local mtime
    mtime=$(stat -c %Y "$d" 2>/dev/null || echo 0)
    if (( mtime > best_mtime )); then
      best_mtime=$mtime
      best=$base
    fi
  done
  if [[ -n "$best" ]]; then
    echo "$best"
    return 0
  fi
  return 1
}

# Minimal binary VDF writer for a single non-Steam shortcut.
# Appends one entry to an existing shortcuts.vdf or creates a new one.
# Format is the binary KeyValues layout Steam expects.
add_nonsteam_shortcut() {
  local app_name="$1"
  local exe_path="$2"      # absolute path to the .bat (or launcher)
  local start_dir="$3"     # absolute directory

  local userdata userid shortcuts
  userdata=$(find_steam_userdata) || {
    echo -e "${YELLOW}Could not locate Steam userdata. Skipping non-Steam shortcut.${RESET}"
    echo "After restarting Steam you can add it manually: Games → Add a Non-Steam Game → browse to:"
    echo "  $exe_path"
    return 0
  }
  userid=$(find_steam_userid) || {
    echo -e "${YELLOW}Could not determine Steam user ID. Skipping non-Steam shortcut.${RESET}"
    return 0
  }

  local config_dir="$userdata/$userid/config"
  mkdir -p "$config_dir"
  shortcuts="$config_dir/shortcuts.vdf"

  # Steam must be closed while we write the file
  if pgrep -x steam >/dev/null 2>&1 || pgrep -f "steam.sh" >/dev/null 2>&1; then
    echo -e "${YELLOW}Steam appears to be running. Close Steam completely, then re-run this script${RESET}"
    echo -e "${YELLOW}or add the shortcut manually after the download finishes.${RESET}"
    echo "Manual path: $exe_path"
    return 0
  fi

  # Quote style matching Steam's usual format
  local exe_quoted="\"$exe_path\""
  local start_quoted="\"$start_dir\""

  # Generate a non-Steam appid (high bit set). Steam uses CRC32(exe+name)|0x80000000;
  # a deterministic hash is fine for uniqueness.
  local appid
  appid=$(printf '%s%s' "$exe_path" "$app_name" | md5sum | cut -c1-8)
  appid=$(( 0x80000000 | 16#$appid ))

  # Always back up before touching the file
  if [[ -f "$shortcuts" ]]; then
    cp -a "$shortcuts" "${shortcuts}.bak.$(date +%s)" || true
  fi

  # Append-aware binary VDF writer:
  # - If the file is missing/empty/invalid → create a fresh single-entry file.
  # - If it already has entries → find the highest numeric key, insert one more,
  #   and leave every existing entry untouched.
  python3 - "$shortcuts" "$appid" "$app_name" "$exe_quoted" "$start_quoted" <<'PY'
import struct, sys, os

path, appid_s, app_name, exe, start_dir = sys.argv[1:6]
appid = int(appid_s) & 0xFFFFFFFF

def write_cstring(buf, s):
    buf.extend(s.encode("utf-8"))
    buf.append(0)

def write_u32(buf, v):
    buf.extend(struct.pack("<I", v & 0xFFFFFFFF))

def build_entry(index: str) -> bytes:
    """One shortcut object (type 0x00, key = index)."""
    b = bytearray()
    b.append(0x00)                 # object
    write_cstring(b, index)
    # appid
    b.append(0x02); write_cstring(b, "appid"); write_u32(b, appid)
    # strings
    for key, val in (
        ("AppName", app_name),
        ("Exe", exe),
        ("StartDir", start_dir),
        ("icon", ""),
        ("ShortcutPath", ""),
        ("LaunchOptions", ""),
    ):
        b.append(0x01); write_cstring(b, key); write_cstring(b, val)
    # ints
    for key, val in (
        ("IsHidden", 0),
        ("AllowDesktopConfig", 1),
        ("AllowOverlay", 1),
        ("OpenVR", 0),
        ("Devkit", 0),
        ("DevkitOverrideAppID", 0),
        ("LastPlayTime", 0),
    ):
        b.append(0x02); write_cstring(b, key); write_u32(b, val)
    b.append(0x01); write_cstring(b, "DevkitGameID"); write_cstring(b, "")
    b.append(0x01); write_cstring(b, "FlatpakAppID"); write_cstring(b, "")
    # empty tags map
    b.append(0x00); write_cstring(b, "tags"); b.append(0x08)
    b.append(0x08)                 # end of this entry object
    return bytes(b)

def read_cstring(data, i):
    j = data.index(0, i)
    return data[i:j].decode("utf-8", errors="replace"), j + 1

def next_index_and_append(data: bytes) -> bytes:
    """
    Parse top-level 'shortcuts' map, find highest integer key, return
    a new file with one extra entry appended just before the final 0x08.
    """
    if not data or data[0] != 0x00:
        raise ValueError("not a binary VDF object")

    # expect key "shortcuts"
    key, i = read_cstring(data, 1)
    if key != "shortcuts":
        raise ValueError(f"root key is {key!r}, expected 'shortcuts'")

    # Walk sibling entries under shortcuts; each is 0x00 <index>\0 ... 0x08
    # We only need the max numeric index and the position of the final 0x08
    # that closes the shortcuts object.
    max_idx = -1
    pos = i
    depth = 1          # inside the shortcuts object
    while pos < len(data) and depth > 0:
        t = data[pos]
        pos += 1
        if t == 0x08:          # end of current object
            depth -= 1
            continue
        if t not in (0x00, 0x01, 0x02):
            raise ValueError(f"unknown type byte 0x{t:02x} at {pos-1}")
        k, pos = read_cstring(data, pos)
        if t == 0x00:          # nested object (an entry, or tags, …)
            # top-level children of shortcuts are the numbered entries
            if depth == 1 and k.isdigit():
                max_idx = max(max_idx, int(k))
            depth += 1
        elif t == 0x01:        # string value
            _, pos = read_cstring(data, pos)
        elif t == 0x02:        # int32
            pos += 4

    if depth != 0:
        raise ValueError("unbalanced VDF (missing 0x08)")

    # pos now points just past the final 0x08 of the root object.
    # Insert the new entry immediately before that last byte.
    insert_at = pos - 1
    new_idx = str(max_idx + 1)
    entry = build_entry(new_idx)
    return data[:insert_at] + entry + data[insert_at:]

def fresh_file() -> bytes:
    b = bytearray()
    b.append(0x00)
    write_cstring(b, "shortcuts")
    b.extend(build_entry("0"))
    b.append(0x08)                 # end shortcuts
    return bytes(b)

# --- main ---
if os.path.isfile(path) and os.path.getsize(path) > 0:
    with open(path, "rb") as f:
        raw = f.read()
    try:
        out = next_index_and_append(raw)
        action = "appended"
    except Exception as e:
        # Corrupt / unexpected layout → fall back to a clean single-entry file
        # (backup already made by the shell).
        print(f"Existing shortcuts.vdf unreadable ({e}); writing a fresh one.", file=sys.stderr)
        out = fresh_file()
        action = "replaced (was unreadable)"
else:
    out = fresh_file()
    action = "created"

with open(path, "wb") as f:
    f.write(out)
print(f"{action}: {path}")
PY

  echo -e "${GREEN}Added non-Steam shortcut \"${app_name}\" pointing at:${RESET}"
  echo "  $exe_path"
  echo -e "${CYAN}Restart Steam, then set the shortcut's Compatibility to a Proton version${RESET}"
  echo -e "${CYAN}(right-click → Properties → Compatibility → Force the use of a specific Steam Play tool).${RESET}"
}

# ========== main flow ==========

echo -e "${CYAN}RecFlare / Rec Room 2025 client setup (Linux)${RESET}"
echo -e "Install directory: ${GREEN}${INSTALL_DIR}${RESET}"
echo

# Non-interactive / one-shot:
#   RECFLARE_NO_STEAM=1 ./download.sh
#   ./download.sh --no-steam
#   curl ... | RECFLARE_NO_STEAM=1 bash
# Default when interactive: NO (mirror). Only y/yes uses DepotDownloader.
USE_STEAM=0
if [[ "${1:-}" == "--steam" ]] || [[ "${RECFLARE_USE_STEAM:-}" == "1" ]]; then
  USE_STEAM=1
elif [[ "${1:-}" == "--no-steam" ]] || [[ "${RECFLARE_NO_STEAM:-}" == "1" ]]; then
  USE_STEAM=0
elif [[ -t 0 ]]; then
  # Interactive terminal: ask, default N
  read -r -p "Do you have Rec Room in your Steam library? [y/N] " answer
  answer=${answer,,}
  if [[ "$answer" == "y" || "$answer" == "yes" ]]; then
    USE_STEAM=1
  fi
else
  # Piped / non-TTY: default to mirror (no Steam)
  echo "Non-interactive run → using mirror download (no Steam library)."
  USE_STEAM=0
fi

if [[ "$USE_STEAM" == "1" ]]; then
  # --- Steam / DepotDownloader path ---
  if [[ -n "${STEAM_USERNAME:-}" ]]; then
    : # already set via env
  elif [[ -t 0 ]]; then
    read -r -p "Enter your Steam username: " STEAM_USERNAME
  else
    echo -e "${RED}Steam mode needs STEAM_USERNAME env var in non-interactive runs.${RESET}"
    exit 1
  fi
  if [[ -z "${STEAM_USERNAME}" ]]; then
    echo -e "${RED}No username entered - stopping.${RESET}"
    exit 1
  fi

  echo -e "${CYAN}=== Installing DepotDownloader ===${RESET}"
  curl -s -f -L -o DepotDownloader.zip \
    "https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_3.4.0/DepotDownloader-linux-x64.zip"
  mkdir -p DepotDownloader
  unzip -qo DepotDownloader.zip -d DepotDownloader
  rm -f DepotDownloader.zip
  chmod +x DepotDownloader/DepotDownloader

  echo -e "${CYAN}=== Downloading depot via DepotDownloader (will prompt for Steam password / 2FA) ===${RESET}"
  ./DepotDownloader/DepotDownloader \
    -remember-password \
    -app 471710 \
    -depot 471711 \
    -manifest 1151455856673601091 \
    -dir . \
    -username "$STEAM_USERNAME"
else
  # --- Mirror / bucket path ---
  CLIENT_MD5="6820e89bff41906ded7f5c066027f1d6"
  if [[ -f client.zip ]]; then
    echo -e "${CYAN}=== Checking existing client.zip ===${RESET}"
    LOCAL_MD5=$(md5sum client.zip | awk '{print $1}')
    if [[ "${LOCAL_MD5,,}" == "${CLIENT_MD5,,}" ]]; then
      echo -e "${GREEN}client.zip already matches expected hash - skipping download.${RESET}"
    else
      echo -e "${RED}client.zip does not match expected hash - redownloading.${RESET}"
      rm -f client.zip
    fi
  fi

  if [[ ! -f client.zip ]]; then
    echo -e "${CYAN}=== Downloading game client from mirror ===${RESET}"
    curl -f -L -o client.zip \
      "https://s3.g.megas4.com/2koayuyiwxv4groxzwdbbxg43cwustavrkvfb/recflare/2025/client.zip"
  fi

  echo -e "${CYAN}=== Extracting game client ===${RESET}"
  # client.zip is a real ZIP (Windows tar can open it; GNU tar on Linux cannot)
  unzip -qo client.zip -d .
fi

# Common post-download steps
echo -e "${CYAN}=== Writing steam_appid.txt ===${RESET}"
echo 480 > steam_appid.txt

echo -e "${CYAN}=== Downloading Rec Room 2025 patch ===${RESET}"
curl -s -f -L -o 2025Patch.zip \
  "https://github.com/recflare/patch-2025/releases/download/${PATCH_VERSION}/2025Patch-${PATCH_VERSION}-x64.zip"
unzip -qo 2025Patch.zip -d .
rm -f 2025Patch.zip

echo -e "${CYAN}=== Pointing 2025patch.ini at RecFlare ===${RESET}"
# Update or create 2025patch.ini with ApiHost / PhotonHost
python3 - <<'PY'
from pathlib import Path
p = Path("2025patch.ini")
hosts = {
    "ApiHost": "ns.recflare.net",
    "PhotonHost": "photon.recflare.net",
}
lines = p.read_text().splitlines() if p.exists() else ["[config]"]
# Ensure we have a [config] section
if not any(l.strip().startswith("[") for l in lines):
    lines.insert(0, "[config]")

def set_key(key, value):
    global lines
    import re
    pat = re.compile(r"^\s*" + re.escape(key) + r"\s*=")
    for i, line in enumerate(lines):
        if pat.match(line):
            lines[i] = f"{key}={value}"
            return
    lines.append(f"{key}={value}")

for k, v in hosts.items():
    set_key(k, v)

p.write_text("\n".join(lines) + "\n")
print("Updated 2025patch.ini")
PY

# Locate the screen launcher that ships with the patch
SCREEN_BAT=""
for candidate in RecRoomScreen.bat RecRoomScreen.BAT screen.bat; do
  if [[ -f "$candidate" ]]; then
    SCREEN_BAT="$SCRIPT_DIR/$candidate"
    break
  fi
done

if [[ -z "$SCREEN_BAT" ]]; then
  echo -e "${YELLOW}RecRoomScreen.bat not found after patch extract – skipping Steam shortcut.${RESET}"
else
  echo
  echo -e "${CYAN}=== Adding non-Steam library entry for RecRoomScreen.bat ===${RESET}"
  add_nonsteam_shortcut "Rec Room (RecFlare Screen)" "$SCREEN_BAT" "$SCRIPT_DIR"
fi

echo
echo -e "${GREEN}=== Done ===${RESET}"
echo
echo "Next steps:"
echo "  1. Restart Steam (if it was open)."
echo "  2. In the Steam library, find \"Rec Room (RecFlare Screen)\"."
echo "  3. Right-click → Properties → Compatibility → enable Proton (any recent version)."
echo "  4. Launch from Steam, or run the .bat via protontricks / wine manually:"
echo "       wine \"$SCREEN_BAT\""
echo
echo "The game files and patch live in:"
echo "  $SCRIPT_DIR"
