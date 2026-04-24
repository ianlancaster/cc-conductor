import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "../src/engine/state-store.js";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("StateStore", () => {
  let store: StateStore;
  const dbPath = join(tmpdir(), `conductor-test-${Date.now()}.db`);

  beforeEach(() => {
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
  });

  it("creates tables on initialization", () => {
    const tables = store.listTables();
    expect(tables).toContain("sessions");
    expect(tables).toContain("messages");
    expect(tables).toContain("escalations");
    expect(tables).toContain("health_log");
    expect(tables).toContain("permission_log");
  });

  it("inserts and retrieves a session", () => {
    store.insertSession({
      id: "test-session-1",
      agent: "<name>",
      status: "active",
      promptSummary: "Run /caffeinate",
    });
    const session = store.getSession("test-session-1");
    expect(session).toBeDefined();
    expect(session!.agent).toBe("<name>");
    expect(session!.status).toBe("active");
  });

  it("updates session status", () => {
    store.insertSession({ id: "s1", agent: "<name>", status: "active", promptSummary: "test" });
    store.updateSession("s1", { status: "completed", turns: 42, costUsd: 0.15 });
    const session = store.getSession("s1");
    expect(session!.status).toBe("completed");
    expect(session!.turns).toBe(42);
  });

  it("inserts and retrieves escalations", () => {
    store.insertEscalation({
      agent: "<name>",
      sessionId: "s1",
      actionType: "Bash",
      actionDetail: '{"command":"pip install torch"}',
      agentContext: "Installing PyTorch for experiment",
    });
    const pending = store.getPendingEscalations();
    expect(pending).toHaveLength(1);
    expect(pending[0].agent).toBe("<name>");
    expect(pending[0].action_type).toBe("Bash");
  });

  it("resolves an escalation", () => {
    store.insertEscalation({
      agent: "<name>",
      sessionId: "s1",
      actionType: "Bash",
      actionDetail: "{}",
      agentContext: "test",
    });
    const pending = store.getPendingEscalations();
    store.resolveEscalation(pending[0].id, "approved", "<name>", "Go ahead");
    const resolved = store.getPendingEscalations();
    expect(resolved).toHaveLength(0);
  });

  it("logs health events", () => {
    store.logHealthEvent("<name>", "stall_detected", "No output for 5 minutes");
    const events = store.getHealthLog("<name>", 10);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("stall_detected");
  });

  it("logs permission decisions", () => {
    store.logPermission("<name>", "Bash", "git status", 1, "approved", "rule");
    const log = store.getPermissionLog("<name>", 10);
    expect(log).toHaveLength(1);
    expect(log[0].tier).toBe(1);
  });

  it("inserts and retrieves messages", () => {
    store.insertMessage({
      sender: "<name>",
      recipient: "<name>",
      type: "consultation",
      content: "What is your latest Phi measurement?",
    });
    const messages = store.getPendingMessages("<name>");
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe("<name>");
  });
});
