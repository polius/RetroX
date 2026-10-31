#!/bin/sh
set -eu

DATA_DIR="${RETROX_DATA_DIR:-/data}"
DEMO_SENTINEL="${DATA_DIR}/.demo_seeded"

if [ ! -w "${DATA_DIR}" ]; then
  echo "RetroX: ${DATA_DIR} is not writable by uid $(id -u), gid $(id -g)." >&2
  echo "Give that user write access to the folder you mounted at ${DATA_DIR}," >&2
  echo "or run the container as its owner (e.g. --user \$(id -u):\$(id -g) / user: in compose)." >&2
  exit 1
fi

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

# RETROX_TRUSTED_PROXIES wins; FORWARDED_ALLOW_IPS (uvicorn's own variable,
# which older setups may already set) is still honoured as a fallback.
exec uvicorn app.main:app \
  --app-dir /app/backend \
  --host "${RETROX_HOST:-0.0.0.0}" \
  --port "${RETROX_PORT:-8080}" \
  --proxy-headers \
  --forwarded-allow-ips "${RETROX_TRUSTED_PROXIES:-${FORWARDED_ALLOW_IPS:-127.0.0.1,::1}}"
