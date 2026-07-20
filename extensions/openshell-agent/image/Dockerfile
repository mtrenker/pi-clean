# syntax=docker/dockerfile:1.4
# Pinned OpenShell Community Pi image built from commit
# a2afd1ba5d0655ed531d7cd0bd7e1b93cb788a61; do not silently track latest.
ARG BASE_IMAGE=ghcr.io/nvidia/openshell-community/sandboxes/pi@sha256:88716cf8c342af78b2af20e6e3b2c55e27eecea5a989fcbeaf61c10e0ec1df02
FROM ${BASE_IMAGE}

USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/openshell-browser/browsers
COPY package.json package-lock.json /opt/openshell-browser/
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends passwd xvfb x11vnc xauth novnc websockify libnss3-tools \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --ignore-scripts --prefix /opt/openshell-browser \
    && node /opt/openshell-browser/node_modules/playwright-core/cli.js install --with-deps chromium \
    && /usr/sbin/useradd --uid 2000 --user-group --create-home --home-dir /var/lib/openshell-browser browser \
    && /usr/sbin/usermod -a -G sandbox browser \
    && mkdir -p /run/openshell-browser /var/lib/openshell-browser/profile \
    && chown -R browser:browser /var/lib/openshell-browser \
    && chown root:sandbox /run/openshell-browser \
    && chmod 0700 /var/lib/openshell-browser /var/lib/openshell-browser/profile \
    && chmod 0770 /run/openshell-browser \
    && chmod -R a+rX /opt/openshell-browser

COPY browser-controller.mjs /opt/openshell-browser/browser-controller.mjs
COPY codex-relay.mjs /opt/openshell-agent/codex-relay.mjs
COPY entrypoint.sh /opt/openshell-browser/entrypoint.sh
RUN ln /usr/bin/node /opt/openshell-agent/relay-node \
    && chmod 0755 /opt/openshell-browser/entrypoint.sh /opt/openshell-browser/browser-controller.mjs \
    && chmod 0555 /opt/openshell-agent/codex-relay.mjs /opt/openshell-agent/relay-node

# OpenShell intentionally replaces image entrypoints. The host starts the fixed
# browser service script through sandbox exec under policy-pinned UID 2000.
# noVNC remains loopback-only and is reached through `openshell forward service`.
