export type ClassificationResult = {
  decision: "approve" | "deny" | "escalate";
  confidence: number;
  reasoning: string;
};

export class LocalModel {
  private endpoint: string;
  private model: string;
  private confidenceThreshold: number;

  constructor(endpoint: string, model: string, confidenceThreshold: number) {
    this.endpoint = endpoint;
    this.model = model;
    this.confidenceThreshold = confidenceThreshold;
  }

  async classify(prompt: string): Promise<ClassificationResult> {
    try {
      const response = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          format: "json",
          stream: false,
          options: { temperature: 0.1 },
        }),
      });

      if (!response.ok) {
        return { decision: "escalate", confidence: 0, reasoning: "Local model unavailable" };
      }

      const data = (await response.json()) as { response: string };
      const parsed = JSON.parse(data.response) as ClassificationResult;

      if (parsed.confidence < this.confidenceThreshold) {
        return {
          ...parsed,
          decision: "escalate",
          reasoning: `Low confidence (${parsed.confidence}): ${parsed.reasoning}`,
        };
      }

      return parsed;
    } catch {
      return { decision: "escalate", confidence: 0, reasoning: "Local model error — escalating" };
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async draftResponse(agent: string, question: string, context: string, options?: string[]): Promise<{
    response: string;
    confidence: number;
    reasoning: string;
  }> {
    const optionsText = options?.length
      ? `\nAvailable options: ${options.map((o, i) => `${i + 1}. ${o}`).join(", ")}`
      : "";

    const prompt = `You are the conductor of an AI agent network. An agent has stalled and needs a nudge to continue working. Draft a brief, actionable response that will get the agent moving again.

Agent: ${agent}
What the agent said: ${question}
Recent terminal context: ${context}${optionsText}

Rules:
- If the agent asked a question with options, pick the most reasonable option
- If the agent is asking for approval, give approval with a brief reason
- If the agent seems stuck or confused, give clear direction
- Keep your response under 2 sentences — concise and actionable
- Write as the human operator would — direct, not formal

Respond as JSON: {"response": "your nudge text", "confidence": 0.0-1.0, "reasoning": "why you chose this"}`;

    try {
      const result = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          format: "json",
          stream: false,
          options: { temperature: 0.3 },
        }),
      });

      if (!result.ok) {
        return { response: "", confidence: 0, reasoning: "Local model unavailable" };
      }

      const data = (await result.json()) as { response: string };
      return JSON.parse(data.response);
    } catch {
      return { response: "", confidence: 0, reasoning: "Local model error" };
    }
  }

  async classifyStall(agent: string, paneContent: string): Promise<{
    status: "waiting_for_input" | "idle";
    confidence: number;
    summary: string;
  }> {
    const prompt = `You are monitoring an AI agent's terminal output. The agent has stopped producing output. Classify whether it needs a human response to continue.

IMPORTANT: Ignore terminal UI elements like prompt markers (❯, $, %), status bars, "bypass permissions", spinners, or decorative lines. Focus ONLY on the agent's actual conversational text — what it said to the user.

Classify as:
- "waiting_for_input": The agent's last conversational message asks a question, presents options, requests approval, or otherwise needs a human response before continuing.
- "idle": The agent completed its work, said something like "done" or "standing by", or has no pending question.

Agent: ${agent}
Terminal output:
${paneContent}

Respond as JSON: {"status": "waiting_for_input"|"idle", "confidence": 0.0-1.0, "summary": "one sentence describing what the agent asked or said"}`;

    try {
      const result = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          format: "json",
          stream: false,
          options: { temperature: 0.1 },
        }),
      });

      if (!result.ok) {
        return { status: "idle", confidence: 0, summary: "Local model unavailable" };
      }

      const data = (await result.json()) as { response: string };
      return JSON.parse(data.response);
    } catch {
      return { status: "idle", confidence: 0, summary: "Local model error" };
    }
  }

  buildPermissionPrompt(agent: string, toolName: string, input: Record<string, unknown>): string {
    const inputStr = JSON.stringify(input).slice(0, 500);
    return `You are a permission classifier for an AI agent network supervisor.

Agent "${agent}" wants to execute tool "${toolName}" with input: ${inputStr}

Classify this action as one of:
- "approve": safe, routine operation
- "deny": dangerous or prohibited
- "escalate": needs human review

Respond as JSON: {"decision": "approve"|"deny"|"escalate", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;
  }
}
