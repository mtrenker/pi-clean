#!/bin/sh
set -eu

mkdir -p /run/openshell-browser /var/lib/openshell-browser/profile
chown browser:browser /var/lib/openshell-browser /var/lib/openshell-browser/profile
chmod 0700 /var/lib/openshell-browser /var/lib/openshell-browser/profile
rm -f /run/openshell-browser/paused

XAUTHORITY=/var/lib/openshell-browser/.Xauthority
runuser -u browser -- sh -c "touch '$XAUTHORITY' && chmod 0600 '$XAUTHORITY' && xauth -f '$XAUTHORITY' add :99 . \$(mcookie)"
runuser -u browser -- Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -auth "$XAUTHORITY" >/dev/null 2>&1 &
runuser -u browser -- websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &

(
  while :; do
    runuser -u browser -- env HOME=/var/lib/openshell-browser DISPLAY=:99 XAUTHORITY="$XAUTHORITY" node /opt/openshell-browser/browser-controller.mjs || true
    sleep 1
  done
) >/dev/null 2>&1 &

# The browser controller stops its own process on takeover. This root-owned
# monitor is the only component that may resume that other-UID process after
# the host removes the explicit pause marker.
(
  while :; do
    if [ ! -e /run/openshell-browser/paused ] && [ -r /run/openshell-browser/controller.pid ]; then
      pid=$(cat /run/openshell-browser/controller.pid 2>/dev/null || true)
      case "$pid" in (*[!0-9]*|'') ;; (*) kill -CONT "$pid" 2>/dev/null || true ;; esac
    fi
    sleep 0.2
  done
) >/dev/null 2>&1 &

if [ "$#" -eq 0 ]; then
  set -- /bin/bash
fi
exec runuser -u sandbox -- "$@"
