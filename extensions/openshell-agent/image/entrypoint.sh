#!/bin/sh
set -eu

# This fixed image-owned service is launched by the host in the browser-only
# sandbox. No untrusted worker process runs in this sandbox.
XAUTHORITY=/var/lib/openshell-browser/.Xauthority
export HOME=/var/lib/openshell-browser
export DISPLAY=:99
export XAUTHORITY
export PLAYWRIGHT_BROWSERS_PATH=/opt/openshell-browser/browsers

mkdir -p /run/openshell-browser /var/lib/openshell-browser/profile "$HOME/.pki/nssdb"
touch "$XAUTHORITY"
chmod 0600 "$XAUTHORITY"
xauth -f "$XAUTHORITY" add :99 . "$(mcookie)"
certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password 2>/dev/null || true
certutil -d "sql:$HOME/.pki/nssdb" -D -n openshell-local-ca 2>/dev/null || true
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n openshell-local-ca -i /etc/openshell-tls/openshell-ca.pem

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -auth "$XAUTHORITY" >/var/lib/openshell-browser/xvfb.log 2>&1 &
websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/var/lib/openshell-browser/websockify.log 2>&1 &
exec node /opt/openshell-browser/browser-controller.mjs
