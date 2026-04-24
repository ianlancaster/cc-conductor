import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("loadConfig", () => {
  const testDir = join(tmpdir(), "conductor-test-config-" + Date.now());

  function setup() {
    mkdirSync(join(testDir, "config", "agents"), { recursive: true });
    writeFileSync(
      join(testDir, "config", "supervisor.yaml"),
      `supervisor:
  heartbeatIntervalSeconds: 30
  stallThresholdMinutes: 5
  stallRestartAttempts: 1
  defaultMaxTurns: 100
  logLevel: info
localModel:
  provider: ollama
  model: qwen3:8b
  endpoint: http://localhost:11434
  idleTimeoutMinutes: 10
  confidenceThreshold: 0.7
telegram:
  escalationExpiryHours: 24
  escalationDefaultAction: deny
database:
  path: ./data/conductor.db
claudeCode:
  binary: claude
  defaultModel: claude-opus-4-6
`
    );
    writeFileSync(
      join(testDir, "config", "agents", "<name>.yaml"),
      `agent: <name>
codename: <name>
repo: /tmp/test-agents/<name>
model: claude-opus-4-6
maxTurns: 100
additionalDirs:
  - /tmp/test-agents/water-cooler
autoApprove:
  tools:
    - Read
    - Edit
    - Write
  paths:
    write:
      - "**"
    read:
      - "**"
  bash:
    allow:
      - "git *"
    deny:
      - "sudo *"
escalateAlways: []
peerAccess:
  canConsult:
    - <name>
  canReceiveFrom:
    - <name>
`
    );
    return testDir;
  }

  it("loads supervisor config and agent policies", () => {
    const dir = setup();
    const config = loadConfig(dir);
    expect(config.supervisor.heartbeatIntervalSeconds).toBe(30);
    expect(config.supervisor.stallThresholdMinutes).toBe(5);
    expect(config.agents.<name>).toBeDefined();
    expect(config.agents.<name>.repo).toBe("/tmp/test-agents/<name>");
    expect(config.agents.<name>.autoApprove.tools).toContain("Read");
    expect(config.agents.<name>.autoApprove.bash.deny).toContain("sudo *");
    rmSync(dir, { recursive: true });
  });

  it("throws on missing supervisor config", () => {
    const emptyDir = join(tmpdir(), "conductor-test-empty-" + Date.now());
    mkdirSync(emptyDir, { recursive: true });
    expect(() => loadConfig(emptyDir)).toThrow();
    rmSync(emptyDir, { recursive: true });
  });
});
