export type EscalateParams = {
  agent: string;
  sessionId: string | null;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;
  priority?: string;
};

export type EscalationQueueOptions = {
  sendTelegram: (text: string, buttons?: TelegramButton[][]) => Promise<void>;
  getPendingEscalations: () => {
    id: number;
    created_at: string;
    agent: string;
    action_type: string;
    action_detail: string;
    status: string;
  }[];
  resolveEscalation: (id: number, status: "approved" | "denied" | "expired", resolvedBy: string, note?: string) => void;
  insertEscalation: (params: {
    agent: string;
    sessionId: string | null;
    actionType: string;
    actionDetail: string;
    agentContext: string | null;
    priority?: string;
  }) => void;
  expiryHours: number;
  defaultAction: string;
};

export type TelegramButton = {
  text: string;
  callback_data: string;
};

export class EscalationQueue {
  private options: EscalationQueueOptions;

  constructor(options: EscalationQueueOptions) {
    this.options = options;
  }

  async escalate(params: EscalateParams) {
    const inputSummary =
      params.toolName === "Bash"
        ? ((params.toolInput.command as string)?.slice(0, 200) ?? JSON.stringify(params.toolInput).slice(0, 200))
        : JSON.stringify(params.toolInput).slice(0, 200);

    this.options.insertEscalation({
      agent: params.agent,
      sessionId: params.sessionId,
      actionType: params.toolName,
      actionDetail: JSON.stringify(params.toolInput).slice(0, 2000),
      agentContext: params.reason,
      priority: params.priority,
    });

    const pending = this.options.getPendingEscalations();
    const latest = pending[pending.length - 1];
    const escalationId = latest?.id ?? 0;

    const text = [
      `🔔 Escalation from ${params.agent}`,
      "",
      `Action: ${params.toolName}(${inputSummary})`,
      `Reason: ${params.reason}`,
    ].join("\n");

    const buttons: TelegramButton[][] = [
      [
        { text: "✅ Approve", callback_data: `approve:${escalationId}` },
        { text: "❌ Deny", callback_data: `deny:${escalationId}` },
      ],
      [{ text: "📋 More Context", callback_data: `context:${escalationId}` }],
    ];

    await this.options.sendTelegram(text, buttons);
  }

  expireOldEscalations() {
    const pending = this.options.getPendingEscalations();
    const expiryMs = this.options.expiryHours * 60 * 60 * 1000;
    const now = Date.now();

    for (const item of pending) {
      const createdAt = new Date(item.created_at).getTime();
      if (now - createdAt > expiryMs) {
        this.options.resolveEscalation(item.id, "expired", "auto-expire");
      }
    }
  }

  handleResponse(escalationId: number, action: "approved" | "denied", note?: string) {
    this.options.resolveEscalation(escalationId, action, "ian", note);
  }
}
