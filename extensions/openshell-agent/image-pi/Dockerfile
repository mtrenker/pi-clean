# Pinned OpenShell Community Pi image built from commit
# a2afd1ba5d0655ed531d7cd0bd7e1b93cb788a61; do not silently track latest.
FROM ghcr.io/nvidia/openshell-community/sandboxes/pi@sha256:88716cf8c342af78b2af20e6e3b2c55e27eecea5a989fcbeaf61c10e0ec1df02

USER root
COPY codex-relay.mjs /opt/openshell-agent/codex-relay.mjs
RUN ln /usr/bin/node /opt/openshell-agent/relay-node \
    && chmod 0555 /opt/openshell-agent/codex-relay.mjs /opt/openshell-agent/relay-node
USER sandbox
