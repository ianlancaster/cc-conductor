import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { StateStore } from "../src/engine/state-store.js";
import { PermissionEngine } from "../src/engine/permission-engine.js";
import { HealthMonitor } from "../src/engine/health-monitor.js";
import { EscalationQueue } from "../src/engine/escalation-queue.js";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, writeFileSync, rmSync } from "fs";

describe("Integration", () => {
  const testDir = join(tmpdir(), `conductor-integration-${Date.now()}`);
  const dbPath = join(testDir, "data", "conductor.db");

  function setup() {
    mkdirSync(join(testDir, "config", "agents"), { recursive: true });
    mkdirSync(join(testDir, "data"), { recursive: true });

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
      join(testDir, "config", "agents", "ford.yaml"),
      `agent: ford
codename: ford
repo: /tmp/fake-ford
model: claude-opus-4-6
maxTurns: 10
autoApprove:
  tools: [Read, Edit, Write, Bash]
  paths:
    write: ["**"]
    read: ["**"]
  bash:
    allow: ["git *", "ls *"]
    deny: ["sudo *"]
escalateAlways: []
peerAccess:
  canConsult: [bernard]
  canReceiveFrom: [bernard]
`
    );
  }

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("config → permission engine → state store flow", () => {
    setup();
    const config = loadConfig(testDir);
    const store = new StateStore(dbPath);
    const engine = new PermissionEngine();

    const decision = engine.evaluate(config.agents.ford, "Bash", { command: "git status" });
    expect(decision.behavior).toBe("allow");

    store.logPermission("ford", "Bash", "git status", decision.tier, decision.behavior, "rule");
    const log = store.getPermissionLog("ford", 10);
    expect(log).toHaveLength(1);

    const escDecision = engine.evaluate(config.agents.ford, "Bash", { command: "docker run nginx" });
    expect(escDecision.behavior).toBe("escalate");

    store.close();
  });

  it("escalation queue → telegram notification flow", async () => {
    setup();
    const store = new StateStore(dbPath);
    const sentMessages: string[] = [];

    const queue = new EscalationQueue({
      sendTelegram: async (text) => {
        sentMessages.push(text);
      },
      getPendingEscalations: () => store.getPendingEscalations(),
      resolveEscalation: (id, status, by, note) => store.resolveEscalation(id, status, by, note),
      insertEscalation: (params) => store.insertEscalation(params),
      expiryHours: 24,
      defaultAction: "deny",
    });

    await queue.escalate({
      agent: "ford",
      sessionId: "test-session",
      toolName: "Bash",
      toolInput: { command: "docker run nginx" },
      reason: "Not in allow list",
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("ford");
    expect(sentMessages[0]).toContain("docker run nginx");

    const pending = store.getPendingEscalations();
    expect(pending).toHaveLength(1);
    queue.handleResponse(pending[0].id, "approved");
    expect(store.getPendingEscalations()).toHaveLength(0);

    store.close();
  });

  it("health monitor can be constructed", () => {
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
