import { describe, it, expect } from "vitest";
import { HealthMonitor } from "../src/engine/health-monitor.js";

describe("HealthMonitor", () => {
  it("can be constructed with required options", () => {
    const monitor = new HealthMonitor({
      heartbeatIntervalSeconds: 30,
      stallBeatsThreshold: 1,
      capturePane: () => "",
      getActiveAgents: () => [],
      onStall: () => {},
      onWorking: () => {},
      logHealthEvent: () => {},
    });
    expect(monitor).toBeDefined();
  });
});
