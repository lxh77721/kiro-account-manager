#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export HOME="${HOME:-/root}"
export SCREEN_WIDTH="${SCREEN_WIDTH:-1600}"
export SCREEN_HEIGHT="${SCREEN_HEIGHT:-900}"
export SCREEN_DEPTH="${SCREEN_DEPTH:-24}"
export VNC_PORT="${VNC_PORT:-5900}"
export NOVNC_PORT="${NOVNC_PORT:-6080}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-root}"

mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.config" "$HOME/.cache"
chmod 700 "$XDG_RUNTIME_DIR"

cleanup() {
  kill 0 >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
fi

if [ -n "${VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/x11vnc.pass >/dev/null
  VNC_AUTH_ARGS=(-rfbauth /tmp/x11vnc.pass)
else
  VNC_AUTH_ARGS=(-nopw)
fi

rm -f /tmp/.X99-lock

Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" -ac +extension GLX +render -noreset &
XVFB_PID=$!

sleep 1

fluxbox >/tmp/fluxbox.log 2>&1 &
FLUXBOX_PID=$!

x11vnc \
  -display "$DISPLAY" \
  -forever \
  -shared \
  -rfbport "$VNC_PORT" \
  -listen 0.0.0.0 \
  "${VNC_AUTH_ARGS[@]}" \
  >/tmp/x11vnc.log 2>&1 &
VNC_PID=$!

websockify --web=/usr/share/novnc/ "0.0.0.0:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/tmp/novnc.log 2>&1 &
NOVNC_PID=$!

if command -v xdg-settings >/dev/null 2>&1 && [ -f /usr/share/applications/chromium.desktop ]; then
  xdg-settings set default-web-browser chromium.desktop >/dev/null 2>&1 || true
  xdg-mime default chromium.desktop x-scheme-handler/http >/dev/null 2>&1 || true
  xdg-mime default chromium.desktop x-scheme-handler/https >/dev/null 2>&1 || true
fi

cd /app
./node_modules/.bin/electron . --no-sandbox --disable-dev-shm-usage &
ELECTRON_PID=$!

wait -n "$ELECTRON_PID" "$NOVNC_PID" "$VNC_PID" "$FLUXBOX_PID" "$XVFB_PID"

