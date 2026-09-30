#!/usr/bin/env bash
#
# Serve the built application with PHP's built-in web server.
#
# PHP is only a static file server here — it cannot transform TypeScript, so
# this script builds the bundle first and serves the resulting dist/ directory.
# There is no PHP application code and no backend; see CLAUDE.md.
#
# Usage:
#   ./web.sh                      # build if needed, serve https on every interface, port 8080
#   ./web.sh -p 9000              # different port
#   ./web.sh -H localhost         # only this machine
#   ./web.sh -i                   # plain http (the mic then works only via localhost)
#   ./web.sh -b                   # force a rebuild first
#   ./web.sh -n                   # skip the build, serve dist/ as it stands
#
# https uses certs/dev-cert.pem and certs/dev-key.pem (shared with the vite dev
# server), generating a self-signed pair if they are missing. PHP cannot speak
# TLS, so tls-proxy.mjs (Node) terminates it and forwards to PHP on a private
# loopback port; plain http on the same port is redirected to https.

set -euo pipefail

PORT=8080
HOST=0.0.0.0
FORCE_BUILD=0
SKIP_BUILD=0
PORT_EXPLICIT=0
HTTPS=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
ROUTER="$ROOT/router.php"
CERT="$ROOT/certs/dev-cert.pem"
KEY="$ROOT/certs/dev-key.pem"

usage() {
  sed -n '3,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while getopts ":p:H:bnih" opt; do
  case "$opt" in
    p) PORT="$OPTARG"; PORT_EXPLICIT=1 ;;
    H) HOST="$OPTARG" ;;
    b) FORCE_BUILD=1 ;;
    n) SKIP_BUILD=1 ;;
    i) HTTPS=0 ;;
    h) usage ;;
    \?) echo "Unknown option: -$OPTARG" >&2; exit 2 ;;
    :) echo "Option -$OPTARG requires an argument" >&2; exit 2 ;;
  esac
done

if ! command -v php >/dev/null 2>&1; then
  echo "error: php not found on PATH." >&2
  echo "       Install PHP, or serve dist/ with any other static file server" >&2
  echo "       (npm run preview, python3 -m http.server, nginx, ...)." >&2
  exit 1
fi

if [ "$HTTPS" -eq 1 ] && ! command -v node >/dev/null 2>&1; then
  echo "error: https needs node to terminate TLS," >&2
  echo "       or pass -i for plain http." >&2
  exit 1
fi

# --- Build ------------------------------------------------------------------

if [ "$SKIP_BUILD" -eq 1 ]; then
  if [ ! -f "$DIST/index.html" ]; then
    echo "error: -n given but $DIST/index.html does not exist. Build first." >&2
    exit 1
  fi
elif [ "$FORCE_BUILD" -eq 1 ] || [ ! -f "$DIST/index.html" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "error: npm not found, and dist/ has not been built." >&2
    exit 1
  fi
  echo "Building..."
  (cd "$ROOT" && npm run build)
  echo
fi

# --- Secure context warning -------------------------------------------------
#
# getUserMedia only works in a secure context. localhost counts as secure; a
# plain-http LAN address does not, and the microphone will silently never start.
# This is the most common "the decoder is broken" report, so warn loudly.

if [ "$HTTPS" -eq 0 ] && [ "$HOST" != "localhost" ] && [ "$HOST" != "127.0.0.1" ]; then
  cat >&2 <<'WARN'
WARNING: serving on a non-localhost address over plain HTTP.

  Browsers block microphone access outside a secure context, so RECEIVE WILL
  NOT WORK when the page is opened via a LAN IP over http://. Transmit still
  works, since playback needs no permission.

  To decode on another machine, drop -i to serve over https, or open the page
  on the host itself.

WARN
fi

# --- Certificate ------------------------------------------------------------
#
# Self-signed, so each browser asks once to accept it. Covers this host's name,
# localhost and every current address; if the addresses change, delete certs/
# and rerun to regenerate.

if [ "$HTTPS" -eq 1 ] && { [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; }; then
  name="$(hostname)"
  san="DNS:$name,DNS:localhost,IP:127.0.0.1"
  for ip in $(hostname -I 2>/dev/null); do san="$san,IP:$ip"; done
  echo "Generating a self-signed certificate for $name..."
  mkdir -p "$(dirname "$CERT")"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$KEY" -out "$CERT" -subj "/CN=$name" \
    -addext "subjectAltName=$san" 2>/dev/null
  chmod 600 "$KEY"
  echo
fi

# --- Serve ------------------------------------------------------------------

# Check the port before printing the banner. php -S reports "Address already in
# use" only after this script has claimed success, which reads as though the
# server started when it did not.
port_in_use() {
  php -r '
    $host = match ($argv[1]) { "0.0.0.0" => "127.0.0.1", "::", "[::]" => "[::1]", default => $argv[1] };
    $sock = @fsockopen($host, (int) $argv[2], $errno, $errstr, 0.5);
    if ($sock) { fclose($sock); exit(0); }
    exit(1);
  ' "$HOST" "$1" 2>/dev/null
}

if port_in_use "$PORT"; then
  if [ "$PORT_EXPLICIT" -eq 1 ]; then
    # An explicit -p is a request, not a suggestion: fail rather than silently
    # serving somewhere the operator is not looking.
    echo "error: something is already listening on $HOST:$PORT." >&2
    exit 1
  fi

  # 8080 is a popular port and often taken by something unrelated. Walk forward
  # to the first free one rather than making the operator guess.
  original=$PORT
  for _ in $(seq 1 20); do
    PORT=$((PORT + 1))
    port_in_use "$PORT" || break
  done

  if port_in_use "$PORT"; then
    echo "error: no free port found between $original and $PORT." >&2
    echo "       Specify one explicitly with -p." >&2
    exit 1
  fi
  echo "note: port $original is in use; serving on $PORT instead." >&2
  echo
fi

SCHEME=http
[ "$HTTPS" -eq 1 ] && SCHEME=https

echo "audiomesh"
echo "  root:  $DIST"
case "$HOST" in
  0.0.0.0|::|"[::]")
    # A wildcard address is not something a browser can open; list real ones.
    echo "  url:   $SCHEME://localhost:$PORT/"
    for ip in $(hostname -I 2>/dev/null); do
      case "$ip" in *:*) ip="[$ip]" ;; esac
      echo "         $SCHEME://$ip:$PORT/"
    done
    ;;
  *) echo "  url:   $SCHEME://$HOST:$PORT/" ;;
esac
echo
echo "Ctrl-C to stop."
echo

if [ "$HTTPS" -eq 0 ]; then
  exec php -S "$HOST:$PORT" -t "$DIST" "$ROUTER"
fi

# PHP on a free loopback port, never reachable from outside; the proxy in front.
INNER_PORT="$(php -r '$s = stream_socket_server("tcp://127.0.0.1:0");
  echo explode(":", stream_socket_get_name($s, false))[1];')"
php -S "127.0.0.1:$INNER_PORT" -t "$DIST" "$ROUTER" &
PHP_PID=$!
trap 'kill "$PHP_PID" 2>/dev/null' EXIT INT TERM

node "$ROOT/tls-proxy.mjs" "$HOST" "$PORT" "$CERT" "$KEY" "$INNER_PORT"
