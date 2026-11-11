#!/usr/bin/env bash
# Steam Deck wrapper for Ryan Rudolph's SteamOS Waydroid Installer.
# It mounts Ryan's Android disk image at /var/lib/waydroid if needed, checks
# the expected files, then runs a pinned upstream fixer revision.
set -Eeuo pipefail

readonly RYAN_IMAGE="${HOME}/Android_Waydroid/waydroid.img"
readonly WD_ROOT="/var/lib/waydroid"
readonly UPSTREAM_REPO="https://github.com/ViviNoSmol/waydroid-small-cookie-fixer.git"
readonly UPSTREAM_COMMIT="8e0797816b7edd15e36c87f292551a5cdbf51173"

fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

[[ -f "$RYAN_IMAGE" ]] || fail "Ryan's Android image was not found at: $RYAN_IMAGE. Run this as the Steam Deck user who installed Waydroid."
for c in sudo git mountpoint findmnt losetup awk sed; do
  command -v "$c" >/dev/null 2>&1 || fail "Required command is missing: $c"
done

mounted_by_us=0
loop_device=""
tmp_dir=""
cleanup() {
  local rc=$?
  if [[ -n "$tmp_dir" && -d "$tmp_dir" ]]; then rm -rf "$tmp_dir"; fi
  if [[ "$mounted_by_us" == 1 ]]; then
    info "Cleaning up the temporary SteamOS image mount"
    sudo systemctl stop waydroid-container.service >/dev/null 2>&1 || true
    sudo umount "$WD_ROOT" >/dev/null 2>&1 || {
      printf 'WARNING: Could not unmount %s. It may still be in use.\n' "$WD_ROOT" >&2
      return "$rc"
    }
    sudo losetup -d "$loop_device" >/dev/null 2>&1 || true
  fi
  return "$rc"
}
trap cleanup EXIT

if mountpoint -q "$WD_ROOT"; then
  loop_device="$(sudo losetup -j "$RYAN_IMAGE" 2>/dev/null | sed -n '1s/:.*//p')"
  mounted_source="$(sudo findmnt -rn -o SOURCE --mountpoint "$WD_ROOT" 2>/dev/null | head -n1)"
  [[ -n "$loop_device" ]] || fail "The Ryan image is mounted, but its loop device could not be identified."
  mounted_device="${mounted_source%%\[*}"
  [[ "$mounted_device" == "$loop_device" ]] || fail "$WD_ROOT is mounted from '$mounted_source', not Ryan's image ($loop_device). Refusing to modify another Waydroid installation."
else
  info "Mounting Ryan's Android image temporarily"
  sudo mkdir -p "$WD_ROOT"
  loop_device="$(sudo losetup --find --show "$RYAN_IMAGE")" || fail "Could not attach Ryan's Android image."
  if ! sudo mount "$loop_device" "$WD_ROOT"; then
    sudo losetup -d "$loop_device" >/dev/null 2>&1 || true
    loop_device=""
    fail "Could not mount Ryan's Android image at $WD_ROOT."
  fi
  mounted_by_us=1
fi

readonly CFG="$WD_ROOT/waydroid.cfg"
readonly BASE_PROP="$WD_ROOT/waydroid_base.prop"
[[ -f "$CFG" ]] || fail "Missing $CFG. This does not look like Ryan's initialized Waydroid image."
[[ -f "$BASE_PROP" ]] || info "Ryan's waydroid_base.prop was not found; continuing with the standard Waydroid config."

image_dir="$(awk -F' *= *' '/^images_path[[:space:]]*=/ {print $2; exit}' "$CFG" 2>/dev/null || true)"
image_dir="${image_dir:-$WD_ROOT/images}"
[[ -f "$image_dir/system.img" ]] || fail "system.img was not found in the configured image directory: $image_dir"
[[ -f "$image_dir/vendor.img" ]] || fail "vendor.img was not found in the configured image directory: $image_dir"

info "Ryan Rudolph image confirmed: $RYAN_IMAGE"
info "Mounted at: $WD_ROOT"
info "Waydroid images: $image_dir"
info "Downloading upstream fixer revision $UPSTREAM_COMMIT"

tmp_dir="$(mktemp -d -t steamdeck-waydroid-fixer.XXXXXX)"
git -C "$tmp_dir" init -q
git -C "$tmp_dir" remote add origin "$UPSTREAM_REPO"
git -C "$tmp_dir" fetch --quiet --depth=1 origin "$UPSTREAM_COMMIT" \
  || fail "Could not download the upstream fixer. Check the Deck's internet connection."
git -C "$tmp_dir" checkout --quiet --detach FETCH_HEAD

fixer="$tmp_dir/waydroid-stealth.sh"
[[ -s "$fixer" ]] || fail "The upstream fixer script was not present in the downloaded revision."
chmod +x "$fixer"

info "Running the upstream fixer against Ryan's mounted Waydroid image."
info "The upstream fixer backs up overlay_rw before applying its changes."
set +e
sudo env HOME="$HOME" bash "$fixer" "$@"
result=$?
set -e

if [[ $result -eq 0 ]]; then
  cat <<'EOT'

The fixer completed. The wrapper will now cleanly unmount the image if it
mounted it temporarily. Launch Waydroid again with Ryan's regular WAYDROID
(non-ROOT) option.

To run the upstream verification after Waydroid is running, launch Waydroid
and run this same file with the argument: verify
EOT
fi
exit "$result"
