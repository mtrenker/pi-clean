# syntax=docker/dockerfile:1.4
# Pinned OpenShell Community Pi image built from commit
# a2afd1ba5d0655ed531d7cd0bd7e1b93cb788a61; do not silently track latest.
ARG BASE_IMAGE=ghcr.io/nvidia/openshell-community/sandboxes/pi:a2afd1b
FROM ${BASE_IMAGE}

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /var/lib/openshell-browser browser \
    && usermod -a -G sandbox browser \
    && mkdir -p /opt/openshell-browser /run/openshell-browser /var/lib/openshell-browser/profile \
    && chown -R browser:browser /var/lib/openshell-browser \
    && chown root:sandbox /run/openshell-browser \
    && chmod 0700 /var/lib/openshell-browser /var/lib/openshell-browser/profile \
    && chmod 0770 /run/openshell-browser \
    && npm install --prefix /opt/openshell-browser playwright-core@1.61.1

COPY browser-controller.mjs /opt/openshell-browser/browser-controller.mjs
COPY entrypoint.sh /opt/openshell-browser/entrypoint.sh
RUN chmod 0755 /opt/openshell-browser/entrypoint.sh /opt/openshell-browser/browser-controller.mjs

# noVNC is loopback-only and must be reached through `openshell forward service`.
# No browser/debugging port is published by the image.
ENTRYPOINT ["/opt/openshell-browser/entrypoint.sh"]
