#!/bin/sh
set -eu

DATA_DIR="${RETROX_DATA_DIR:-/data}"
DEMO_SENTINEL="${DATA_DIR}/.demo_seeded"

mkdir -p \
  "${DATA_DIR}/roms" \
  "${DATA_DIR}/covers" \
  "${DATA_DIR}/saves" \
  "${DATA_DIR}/cores"

for system in gb gbc gba psx n64; do
  mkdir -p "${DATA_DIR}/roms/${system}"
done

# Seed bundled cores into /data/cores/ (skip files that already exist).
# Cores are functional, not demo content, so they always backfill.
for core in /app/docker/cores/*.data; do
  [ -f "$core" ] || continue
  name="$(basename "$core")"
  [ -f "${DATA_DIR}/cores/${name}" ] || cp "$core" "${DATA_DIR}/cores/${name}"
done

# Seed bundled demo ROMs + covers — first boot only. Gated by a sentinel
# file so a user who deletes the demos doesn't see them re-appear after
# a container restart. To restore the demos, just delete the sentinel
# (rm /data/.demo_seeded) and restart.
if [ ! -f "${DEMO_SENTINEL}" ]; then
  echo "First boot: seeding demo ROMs and covers"

  for system_dir in /app/docker/roms/*/; do
    [ -d "$system_dir" ] || continue
    system="$(basename "$system_dir")"
    mkdir -p "${DATA_DIR}/roms/${system}"
    for rom in "${system_dir}"*; do
      [ -f "$rom" ] || continue
      name="$(basename "$rom")"
      cp -n "$rom" "${DATA_DIR}/roms/${system}/${name}" 2>/dev/null || true
    done
  done

  if [ -d /app/docker/covers ]; then
    for cover in /app/docker/covers/*; do
      [ -f "$cover" ] || continue
      name="$(basename "$cover")"
      cp -n "$cover" "${DATA_DIR}/covers/${name}" 2>/dev/null || true
    done
  fi

  : > "${DEMO_SENTINEL}"
fi

exec uvicorn app.main:app \
  --app-dir /app/backend \
  --host "${RETROX_HOST:-0.0.0.0}" \
  --port "${RETROX_PORT:-8080}" \
  --proxy-headers
