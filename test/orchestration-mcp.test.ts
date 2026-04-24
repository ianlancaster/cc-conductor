import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMcpTools, type McpToolDeps, type PolicyCheck } from "../src/mcp/tools.js";
import type { AgentStatusReport } from "../src/supervisor.js";

const baseStatus = (codename: string): AgentStatusReport => ({
  codename,
  domain: codename,
  status: "idle",
  autonomy: "facilitated",
  nudgeLevel: "regular",
  activityStatus: "stopped",
  sessionId: null,
  startedAt: null,
  lastActivityAt: null,
  stallCount: 0,
  pendingEscalations: 0,
});

const buildDeps = (overrides: Partial<McpToolDeps> = {}): McpToolDeps => {
  const allowPolicy = (): PolicyCheck => ({ allowed: true });

  return {
    notifyAgents: vi.fn(async () => undefined),
    broadcastToAgents: vi.fn(async () => "<name>: delivered\nwolf: delivered"),
    requestHumanInput: vi.fn(async () => "approved"),
    respondToUser: vi.fn(async () => "Delivered to user."),

    startAgent: vi.fn(async () => undefined),
    stopAgent: vi.fn(async () => undefined),
    continueAgent: vi.fn(async () => undefined),
    setAutonomy: vi.fn(() => undefined),
    sendToAgent: vi.fn(async () => undefined),

    requestContext: vi.fn(async () => "392K / 1M (39%)"),
    requestRestart: vi.fn(async () => "Restart complete."),

    listAgents: vi.fn(() => [baseStatus("<name>"), baseStatus("<name>")]),
    getAgentStatus: vi.fn((c) => baseStatus(c)),
    listEscalations: vi.fn(() => []),

    checkOrchestrationPolicy: vi.fn(allowPolicy),
    agentExists: vi.fn((c) => ["<name>", "<name>", "wolf", "<name>"].includes(c)),

    ...overrides,
  };
};

describe("MCP orchestration tools", () => {
  let deps: McpToolDeps;
  let tools: ReturnType<typeof buildMcpTools>;

  beforeEach(() => {
    deps = buildDeps();
    tools = buildMcpTools(deps);
  });

  describe("start_agent", () => {
    it("calls startAgent on the happy path", async () => {
      const res = await tools.start_agent.handler({
        from: "<name>",
        codename: "<name>",
      });
      expect(res).toBe("Started <name>.");
      expect(deps.startAgent).toHaveBeenCalledWith("<name>", undefined);
    });

    it("passes prompt through to startAgent", async () => {
      await tools.start_agent.handler({
        from: "<name>",
        codename: "<name>",
        prompt: "do the thing",
      });
      expect(deps.startAgent).toHaveBeenCalledWith("<name>", "do the thing");
    });

    it("rejects unknown agent", async () => {
      const res = await tools.start_agent.handler({
        from: "<name>",
        codename: "nobody",
      });
      expect(res).toMatch(/unknown agent 'nobody'/);
      expect(deps.startAgent).not.toHaveBeenCalled();
    });

    it("rejects when policy denies", async () => {
      deps = buildDeps({
        checkOrchestrationPolicy: vi.fn(() => ({
          allowed: false,
          reason: "policy denies <name> → start → <name>",
        })),
      });
      tools = buildMcpTools(deps);
      const res = await tools.start_agent.handler({
        from: "<name>",
        codename: "<name>",
      });
      expect(res).toMatch(/policy denies/);
      expect(deps.startAgent).not.toHaveBeenCalled();
    });

    it("rejects missing from", async () => {
      const res = await tools.start_agent.handler({ codename: "<name>" });
      expect(res).toMatch(/'from' is required/);
      expect(deps.startAgent).not.toHaveBeenCalled();
    });

    it("rejects missing codename", async () => {
      const res = await tools.start_agent.handler({ from: "<name>" });
      expect(res).toMatch(/'codename' is required/);
      expect(deps.startAgent).not.toHaveBeenCalled();
    });
  });

  describe("stop_agent", () => {
    it("calls stopAgent on the happy path", async () => {
      const res = await tools.stop_agent.handler({
        from: "<name>",
        codename: "<name>",
      });
      expect(res).toBe("Stopped <name>.");
      expect(deps.stopAgent).toHaveBeenCalledWith("<name>");
    });

    it("rejects when policy denies", async () => {
      deps = buildDeps({
        checkOrchestrationPolicy: vi.fn(() => ({
          allowed: false,
          reason: "<name> cannot stop itself",
        })),
      });
      tools = buildMcpTools(deps);
      const res = await tools.stop_agent.handler({
        from: "<name>",
        codename: "<name>",
      });
      expect(res).toMatch(/cannot stop itself/);
      expect(deps.stopAgent).not.toHaveBeenCalled();
    });
  });

  describe("set_autonomy", () => {
    it("sets autonomous", async () => {
      const res = await tools.set_autonomy.handler({
        from: "<name>",
        codename: "<name>",
        mode: "autonomous",
      });
      expect(res).toBe("<name> set to autonomous.");
      expect(deps.setAutonomy).toHaveBeenCalledWith("<name>", "autonomous");
    });

    it("rejects invalid mode", async () => {
      const res = await tools.set_autonomy.handler({
        from: "<name>",
        codename: "<name>",
        mode: "batshit",
      });
      expect(res).toMatch(/mode must be/);
      expect(deps.setAutonomy).not.toHaveBeenCalled();
    });
  });

  describe("send_to_agent", () => {
    it("sends on happy path", async () => {
      await tools.send_to_agent.handler({
        from: "<name>",
        codename: "<name>",
        message: "heads up",
      });
      expect(deps.sendToAgent).toHaveBeenCalledWith("<name>", "[Message from <name>]\nheads up");
    });

    it("rejects empty message", async () => {
      const res = await tools.send_to_agent.handler({
        from: "<name>",
        codename: "<name>",
        message: "",
      });
      expect(res).toMatch(/'message' is required/);
      expect(deps.sendToAgent).not.toHaveBeenCalled();
    });
  });

  describe("list_agents", () => {
    it("returns full list as JSON", async () => {
      const res = await tools.list_agents.handler({});
      const parsed = JSON.parse(res);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].codename).toBe("<name>");
    });

    it("has no policy gate (ungated observability)", async () => {
      await tools.list_agents.handler({});
      expect(deps.checkOrchestrationPolicy).not.toHaveBeenCalled();
    });
  });

  describe("get_agent_status", () => {
    it("returns single agent status", async () => {
      const res = await tools.get_agent_status.handler({ codename: "<name>" });
      const parsed = JSON.parse(res);
      expect(parsed.codename).toBe("<name>");
    });

    it("rejects unknown agent", async () => {
      const res = await tools.get_agent_status.handler({ codename: "nobody" });
      expect(res).toMatch(/unknown agent/);
    });
  });

  describe("broadcast", () => {
    it("broadcasts on happy path", async () => {
      const res = await tools.broadcast.handler({
        from: "<name>",
        message: "usage at 60%",
      });
      expect(res).toContain("delivered");
      expect(deps.broadcastToAgents).toHaveBeenCalledWith("<name>", "usage at 60%");
    });

    it("rejects missing message", async () => {
      const res = await tools.broadcast.handler({
        from: "<name>",
        message: "",
      });
      expect(res).toMatch(/'message' is required/);
      expect(deps.broadcastToAgents).not.toHaveBeenCalled();
    });

    it("rejects unknown sender", async () => {
      const res = await tools.broadcast.handler({
        from: "nobody",
        message: "hi",
      });
      expect(res).toMatch(/unknown agent/);
      expect(deps.broadcastToAgents).not.toHaveBeenCalled();
    });
  });

  describe("existing tools unchanged", () => {
    it("respond_to_user still works", async () => {
      const res = await tools.respond_to_user.handler({
        from: "<name>",
        message: "hi",
      });
      expect(res).toBe("Delivered to user.");
    });
  });
});
