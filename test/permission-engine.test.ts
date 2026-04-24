import { describe, it, expect } from "vitest";
import { PermissionEngine } from "../src/engine/permission-engine.js";
import type { AgentPolicy } from "../src/config.js";

const fordPolicy: AgentPolicy = {
  agent: "ford",
  codename: "ford",
  repo: "/tmp/test-agents/agent-ford",
  model: "claude-opus-4-6",
  maxTurns: 100,
  autoApprove: {
    tools: ["Read", "Edit", "Write", "Grep", "Glob", "Agent"],
    paths: { write: ["**"], read: ["**"] },
    bash: {
      allow: ["git *", "python *", "node *", "ls *", "./scripts/*"],
      deny: ["rm -rf /*", "git push --force *", "sudo *"],
    },
  },
  escalateAlways: [],
  peerAccess: { canConsult: ["bernard"], canReceiveFrom: ["bernard"] },
};

describe("PermissionEngine", () => {
  const engine = new PermissionEngine();

  it("auto-approves tools in the allowlist", () => {
    const result = engine.evaluate(fordPolicy, "Read", { file_path: "/foo/bar.ts" });
    expect(result.behavior).toBe("allow");
    expect(result.tier).toBe(1);
  });

  it("auto-approves bash commands matching allow patterns", () => {
    const result = engine.evaluate(fordPolicy, "Bash", { command: "git status" });
    expect(result.behavior).toBe("allow");
    expect(result.tier).toBe(1);
  });

  it("denies bash commands matching deny patterns", () => {
    const result = engine.evaluate(fordPolicy, "Bash", { command: "sudo rm -rf /" });
    expect(result.behavior).toBe("deny");
    expect(result.tier).toBe(1);
  });

  it("denies rm -rf at root level", () => {
    const result = engine.evaluate(fordPolicy, "Bash", { command: "rm -rf /etc" });
    expect(result.behavior).toBe("deny");
  });

  it("auto-approves script execution", () => {
    const result = engine.evaluate(fordPolicy, "Bash", {
      command: "./scripts/measure-cognitive-footprint.sh --all",
    });
    expect(result.behavior).toBe("allow");
    expect(result.tier).toBe(1);
  });

  it("escalates unknown tools", () => {
    const result = engine.evaluate(fordPolicy, "SomeNewTool", { arg: "value" });
    expect(result.behavior).toBe("escalate");
    expect(result.tier).toBe(2);
  });

  it("escalates bash commands that match neither allow nor deny", () => {
    const result = engine.evaluate(fordPolicy, "Bash", { command: "curl https://example.com" });
    expect(result.behavior).toBe("escalate");
    expect(result.tier).toBe(2);
  });

  it("handles git push --force as deny", () => {
    const result = engine.evaluate(fordPolicy, "Bash", {
      command: "git push --force origin main",
    });
    expect(result.behavior).toBe("deny");
  });

  it("handles escalateAlways paths", () => {
    const policyWithEscalation: AgentPolicy = {
      ...fordPolicy,
      escalateAlways: ["CLAUDE.md"],
    };
    const result = engine.evaluate(policyWithEscalation, "Edit", {
      file_path: "/tmp/test-agents/agent-ford/CLAUDE.md",
    });
    expect(result.behavior).toBe("escalate");
    expect(result.tier).toBe(3);
  });
});
