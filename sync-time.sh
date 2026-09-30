#!/usr/bin/env bash
#
# Check this machine's clock against NTP and correct it.
#
# Slots are UTC-aligned: frames are aimed at the next slot boundary and the
# decoder only searches a bounded start time (+-2 s normal, +-1.5 s medium,
# +-0.9 s fast), so both stations need a clock that is right to well under a
# second. This script measures the offset with one SNTP query and steps the
# clock if it is off by more than the threshold.
#
# Usage:
#   ./sync-time.sh                # measure, sync if off by more than 100 ms
#   ./sync-time.sh -c             # measure only, change nothing
#   ./sync-time.sh -f             # sync even if the clock looks right
#   ./sync-time.sh -t 50          # threshold in ms
#   ./sync-time.sh -s time.google.com   # NTP server (default pool.ntp.org)
#
# Syncing needs root (it asks for sudo). It uses chrony if present, else steps
# the clock with date(1) by the measured offset, then enables the system NTP
# service (systemd-timesyncd) so the clock stays right.

set -euo pipefail

SERVER=pool.ntp.org
THRESHOLD_MS=100
CHECK_ONLY=0
FORCE=0

usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while getopts ":s:t:cfh" opt; do
  case "$opt" in
    s) SERVER="$OPTARG" ;;
    t) THRESHOLD_MS="$OPTARG" ;;
    c) CHECK_ONLY=1 ;;
    f) FORCE=1 ;;
    h) usage ;;
    \?) echo "Unknown option: -$OPTARG" >&2; exit 2 ;;
    :) echo "Option -$OPTARG requires an argument" >&2; exit 2 ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found; it is needed for the SNTP query." >&2
  exit 1
fi

# Prints the clock offset in ms (server minus local; positive = we are behind)
# and the round trip in ms. Standard SNTP: offset = ((t2 - t1) + (t3 - t4)) / 2.
measure() {
  python3 - "$SERVER" <<'PY'
import socket, struct, sys, time
NTP_EPOCH = 2208988800
def ts(buf, i):
    sec, frac = struct.unpack("!II", buf[i:i + 8])
    return sec - NTP_EPOCH + frac / 2**32
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
try:
    addr = socket.getaddrinfo(sys.argv[1], 123, socket.AF_INET, socket.SOCK_DGRAM)[0][4]
    t1 = time.time()
    s.sendto(b"\x23" + 47 * b"\0", addr)  # LI 0, version 4, mode 3 (client)
    buf, _ = s.recvfrom(48)
    t4 = time.time()
except OSError as e:
    sys.exit(f"error: no answer from {sys.argv[1]}: {e}")
if len(buf) < 48 or buf[1] == 0:
    sys.exit(f"error: bad or kiss-of-death reply from {sys.argv[1]}")
t2, t3 = ts(buf, 32), ts(buf, 40)
print(f"{((t2 - t1) + (t3 - t4)) / 2 * 1000:+.1f} {((t4 - t1) - (t3 - t2)) * 1000:.1f}")
PY
}

report() {
  read -r OFFSET_MS RTT_MS <<<"$(measure)"
  printf '  server: %s\n  offset: %s ms (%s)\n  delay:  %s ms\n' \
    "$SERVER" "$OFFSET_MS" \
    "$(awk -v o="$OFFSET_MS" 'BEGIN { print (o >= 0 ? "local clock is behind" : "local clock is ahead") }')" \
    "$RTT_MS"
}

abs_over() {
  awk -v o="$1" -v t="$2" 'BEGIN { exit !((o < 0 ? -o : o) > t) }'
}

echo "Local:  $(date -u '+%Y-%m-%d %H:%M:%S.%3N UTC')"
report

if [ "$CHECK_ONLY" -eq 1 ]; then
  if abs_over "$OFFSET_MS" 1000; then
    echo "WARNING: off by more than 1 s; slots will not line up." >&2
  fi
  exit 0
fi

if [ "$FORCE" -eq 0 ] && ! abs_over "$OFFSET_MS" "$THRESHOLD_MS"; then
  echo "Within ${THRESHOLD_MS} ms; nothing to do."
  exit 0
fi

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO=sudo

echo
if command -v chronyc >/dev/null 2>&1 && chronyc tracking >/dev/null 2>&1; then
  echo "Stepping with chrony..."
  $SUDO chronyc -a makestep >/dev/null
  sleep 1
else
  echo "Stepping the clock by ${OFFSET_MS} ms..."
  # Re-measure right before stepping so sudo's password prompt does not age it.
  $SUDO true
  read -r OFFSET_MS _ <<<"$(measure)"
  $SUDO date -u -s "@$(python3 -c "import time; print(f'{time.time() + $OFFSET_MS / 1000:.3f}')")" >/dev/null
  # Keep it right from now on.
  if command -v timedatectl >/dev/null 2>&1; then
    $SUDO timedatectl set-ntp true 2>/dev/null || true
  fi
fi

echo
echo "After:"
report
if abs_over "$OFFSET_MS" "$THRESHOLD_MS"; then
  echo "WARNING: still off by more than ${THRESHOLD_MS} ms." >&2
  exit 1
fi
echo "Done."
