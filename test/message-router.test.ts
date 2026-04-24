import { describe, it, expect, vi } from "vitest";
import { MessageRouter } from "../src/session/message-router.js";
import type { AgentPolicy } from "../src/config.js";

const makePolicy = (name: string, canConsult: string[]): AgentPolicy => ({
  agent: name,
  codename: name,
  repo: `/agents/${name}`,
  model: "opus",
  maxTurns: 100,
  autoApprove: { tools: [], paths: { write: [], read: [] }, bash: { allow: [], deny: [] } },
  escalateAlways: [],
  peerAccess: { canConsult, canReceiveFrom: canConsult },
});

describe("MessageRouter", () => {
  const mockStartSession = vi.fn().mockResolvedValue({
    sessionId: "s-<name>-1",
    agent: "<name>",
    result: "Phi measurement was 0.42",
    subtype: "success",
  });
  const mockInsertMessage = vi.fn();
  const mockMarkResponded = vi.fn();

  const router = new MessageRouter({
    agents: {
      <name>: makePolicy("<name>", ["<name>"]),
      <name>: makePolicy("<name>", ["<name>"]),
    },
    startSession: mockStartSession,
    insertMessage: mockInsertMessage,
    markMessageResponded: mockMarkResponded,
  });

  it("routes a consultation from <name> to <name>", async () => {
    const response = await router.routeConsultation(
      "<name>",
      "<name>",
      "What is your latest Phi measurement?"
    );

    expect(mockStartSession).toHaveBeenCalledWith("<name>", expect.stringContaining("Phi measurement"));
    expect(response).toContain("0.42");
  });

  it("rejects consultation to agents not in canConsult", async () => {
    await expect(router.routeConsultation("<name>", "wolf", "Market signal?")).rejects.toThrow(
      "<name> cannot consult wolf"
    );
  });
});
