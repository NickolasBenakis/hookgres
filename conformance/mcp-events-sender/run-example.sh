#!/usr/bin/env bash
# Runs check.mjs against example-server.mjs.
#   DATABASE_URL=postgres://... ./run-example.sh            # hookgres/mcp-events
#   ./run-example.sh --broken                                # the naive sender
# Extra arguments go to the server; CHECK_ARGS go to check.mjs.
set -euo pipefail
cd "$(dirname "$0")"
DIR=.mcp-check
PORT="${PORT:-3911}"
PIDFILE="$DIR/server.pid"
mkdir -p "$DIR"
node check.mjs tls --dir "$DIR" >/dev/null

start() {
  NODE_EXTRA_CA_CERTS="$DIR/cert.pem" PORT="$PORT" node example-server.mjs "$@" >"$DIR/server.log" 2>&1 &
  echo $! >"$PIDFILE"
  disown
  for _ in $(seq 1 100); do
    grep -q "ready on" "$DIR/server.log" && return 0
    sleep 0.1
  done
  cat "$DIR/server.log" >&2
  return 1
}
stop() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

if [ "${1:-}" = "restart" ]; then
  shift
  # Simulates a crash: SIGKILL, so nothing in memory gets a chance to flush.
  kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true
  start "$@"
  exit 0
fi

trap stop EXIT
start "$@"
export MCP_TOKEN=test-token
node check.mjs \
  --server "http://127.0.0.1:$PORT/mcp" \
  --event incident.created \
  --trigger "curl -s -X POST http://127.0.0.1:$PORT/emit" \
  --restart "$PWD/run-example.sh restart $*" \
  --tls-dir "$DIR" \
  --auth-env MCP_TOKEN \
  --retry-wait 20 \
  --expect-handshake \
  ${CHECK_ARGS:-}
