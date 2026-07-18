import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { subscribeTaskLifecycle } from "./lifecycle.js";
import {
  FlightdeckTelemetryAdapter,
  type FlightdeckTelemetryStatus,
} from "./telemetry.js";

export default function flightdeckExtension(pi: ExtensionAPI) {
  let adapter: FlightdeckTelemetryAdapter | undefined;
  let unsubscribe: (() => void) | undefined;
  let currentContext: ExtensionContext | undefined;

  const renderCompactStatus = (status: FlightdeckTelemetryStatus): string => {
    const sink = status.sink === "healthy" ? "sink ok" : status.sink === "disabled" ? "off" : "sink error";
    const counts = status.counts;
    return `Flightdeck ●${counts.active} ✓${counts.completed} ✗${counts.failed} ◼${counts.aborted}${counts.stale ? ` stale:${counts.stale}` : ""} · ${sink}`;
  };

  const updateStatus = (status: FlightdeckTelemetryStatus): void => {
    currentContext?.ui.setStatus("flightdeck", renderCompactStatus(status));
  };

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    unsubscribe?.();
    adapter = new FlightdeckTelemetryAdapter({
      sinkPath: process.env.FLIGHTDECK_TELEMETRY_FILE,
      onStatus: updateStatus,
    });
    unsubscribe = subscribeTaskLifecycle((event) => adapter!.handle(event));
    updateStatus(adapter.getStatus());
  });

  pi.on("session_shutdown", async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    await adapter?.flush();
    currentContext?.ui.setStatus("flightdeck", undefined);
    currentContext = undefined;
    adapter = undefined;
  });

  pi.registerCommand("flightdeck:status", {
    description: "Show Claude/Codex task counts and Flightdeck telemetry sink health",
    handler: async (_args, ctx) => {
      const status = adapter?.getStatus() ?? new FlightdeckTelemetryAdapter({
        sinkPath: process.env.FLIGHTDECK_TELEMETRY_FILE,
      }).getStatus();
      const path = status.sinkPath ? `\nsink: ${status.sinkPath}` : "\nsink: disabled (set FLIGHTDECK_TELEMETRY_FILE)";
      const error = status.lastError ? `\nlast error: ${status.lastError}` : "";
      ctx.ui.notify(`${renderCompactStatus(status)}${path}${error}`, status.sink === "error" ? "warning" : "info");
    },
  });
}
