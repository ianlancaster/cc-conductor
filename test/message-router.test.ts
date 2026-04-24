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
    sessionId: "s-bernard-1",
    agent: "bernard",
    result: "Phi measurement was 0.42",
    subtype: "success",
  });
  const mockInsertMessage = vi.fn();
  const mockMarkResponded = vi.fn();

  const router = new MessageRouter({
    agents: {
      ford: makePolicy("ford", ["bernard"]),
      bernard: makePolicy("bernard", ["ford"]),
    },
    startSession: mockStartSession,
    insertMessage: mockInsertMessage,
    markMessageResponded: mockMarkResponded,
  });

  it("routes a consultation from ford to bernard", async () => {
    const response = await router.routeConsultation(
      "ford",
      "bernard",
      "What is your latest Phi measurement?"
    );

    expect(mockStartSession).toHaveBeenCalledWith("bernard", expect.stringContaining("Phi measurement"));
    expect(response).toContain("0.42");
  });

  it("rejects consultation to agents not in canConsult", async () => {
    await expect(router.routeConsultation("ford", "wolf", "Market signal?")).rejects.toThrow(
      "ford cannot consult wolf"
    );
  });
});
