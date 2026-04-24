import { describe, it, expect, vi, beforeEach } from "vitest";
import { EscalationQueue } from "../src/engine/escalation-queue.js";

describe("EscalationQueue", () => {
  const mockSendTelegram = vi.fn().mockResolvedValue(undefined);
  const mockGetPending = vi.fn().mockReturnValue([]);
  const mockResolve = vi.fn();
  const mockInsert = vi.fn();

  let queue: EscalationQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    queue = new EscalationQueue({
      sendTelegram: mockSendTelegram,
      getPendingEscalations: mockGetPending,
      resolveEscalation: mockResolve,
      insertEscalation: mockInsert,
      expiryHours: 24,
      defaultAction: "deny",
    });
  });

  it("queues an escalation and sends telegram notification", async () => {
    mockGetPending.mockReturnValue([{ id: 1 }]);
    await queue.escalate({
      agent: "ford",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "pip install torch" },
      reason: "Not in auto-approve list",
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "ford", actionType: "Bash" })
    );
    expect(mockSendTelegram).toHaveBeenCalled();
  });

  it("expires old escalations", () => {
    mockGetPending.mockReturnValue([
      {
        id: 1,
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        agent: "ford",
        action_type: "Bash",
        action_detail: "{}",
        status: "pending",
      },
    ]);

    queue.expireOldEscalations();
    expect(mockResolve).toHaveBeenCalledWith(1, "expired", "auto-expire");
  });

  it("does not expire recent escalations", () => {
    mockGetPending.mockReturnValue([
      {
        id: 1,
        created_at: new Date().toISOString(),
        agent: "ford",
        action_type: "Bash",
        action_detail: "{}",
        status: "pending",
      },
    ]);

    queue.expireOldEscalations();
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
