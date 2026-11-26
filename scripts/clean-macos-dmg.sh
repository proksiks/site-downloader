#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: clean-macos-dmg.sh path/to/installer.dmg}
output_dir=$(cd -- "$(dirname -- "$image")" && pwd)
image="$output_dir/$(basename -- "$image")"

# Editing the volume would invalidate an existing disk-image signature.
if /usr/bin/codesign --display "$image" >/dev/null 2>&1; then
  printf 'Keeping signed disk image unchanged: %s\n' "$image"
  exit 0
fi

temporary=$(mktemp -d "$output_dir/.clean-dmg.XXXXXX")
mount_point="$temporary/volume"
mounted=false
cleanup() {
  if $mounted; then
    /usr/bin/hdiutil detach "$mount_point" -quiet || return
  fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
mkdir "$mount_point"

/usr/bin/hdiutil convert "$image" -format UDRW -o "$temporary/editable.dmg" -quiet
/usr/bin/hdiutil attach "$temporary/editable.dmg" -readwrite -noautoopen -nobrowse -mountpoint "$mount_point" -quiet
mounted=true
if [[ ! -f "$mount_point/.VolumeIcon.icns" ]]; then
  exit 0
fi

/usr/bin/SetFile -a c "$mount_point"
rm -- "$mount_point/.VolumeIcon.icns"
/usr/bin/hdiutil detach "$mount_point" -quiet
mounted=false
/usr/bin/hdiutil convert "$temporary/editable.dmg" -format UDZO -imagekey zlib-level=9 -o "$temporary/clean.dmg" -quiet
/usr/bin/hdiutil verify "$temporary/clean.dmg" -quiet
mv -f -- "$temporary/clean.dmg" "$image"
printf 'Removed duplicate volume icon: %s\n' "$image"
