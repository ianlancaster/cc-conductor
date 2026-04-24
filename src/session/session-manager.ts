import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SupervisorConfig } from "../config.js";
import type { StateStore } from "../engine/state-store.js";
import type { PermissionEngine } from "../engine/permission-engine.js";
import { randomUUID } from "crypto";

export type ActiveSession = {
  id: string;
  agent: string;
  startedAt: Date;
  lastActivityAt: Date;
};

export type SessionResult = {
  sessionId: string;
  agent: string;
  result: string;
  subtype: string;
  turns: number;
  costUsd: number;
  durationMs: number;
};

export class SessionManager {
  private activeSessions = new Map<string, ActiveSession>();
  private activeQueries = new Map<string, AsyncGenerator<SDKMessage, void>>();

  constructor(
    private config: SupervisorConfig,
    private stateStore: StateStore,
    private permissionEngine: PermissionEngine
  ) {}

  async startSession(
    agentName: string,
    prompt: string,
    onMessage?: (agent: string, message: SDKMessage) => void
  ): Promise<SessionResult> {
    const policy = this.config.agents[agentName];
    if (!policy) {
      throw new Error(`No policy found for agent: ${agentName}`);
    }

    const sessionId = randomUUID();

    this.stateStore.insertSession({
      id: sessionId,
      agent: agentName,
      status: "active",
      promptSummary: prompt.slice(0, 200),
    });

    const canUseTool = this.permissionEngine.buildCanUseTool(
      policy,
      (agent, tool, inputSummary, tier, decision, decidedBy) => {
        this.stateStore.logPermission(agent, tool, inputSummary, tier, decision, decidedBy);
      },
      (agent, tool, input, reason) => {
        this.stateStore.insertEscalation({
          agent,
          sessionId,
          actionType: tool,
          actionDetail: JSON.stringify(input).slice(0, 2000),
          agentContext: reason,
        });
      }
    );

    const q = query({
      prompt,
      options: {
        cwd: policy.repo,
        additionalDirectories: policy.additionalDirs,
        model: policy.model,
        maxTurns: policy.maxTurns,
        permissionMode: "bypassPermissions",
        canUseTool,
      },
    });

    const session: ActiveSession = {
      id: sessionId,
      agent: agentName,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    };
    this.activeSessions.set(sessionId, session);
    this.activeQueries.set(sessionId, q);

    let resultText = "";
    let resultSubtype = "success";
    let turns = 0;
    let costUsd = 0;
    let durationMs = 0;

    try {
      for await (const message of q) {
        session.lastActivityAt = new Date();
        onMessage?.(agentName, message);

        if (message.type === "result") {
          const result = message as SDKResultMessage;
          resultSubtype = result.subtype;
          turns = result.num_turns;
          costUsd = result.total_cost_usd;
          durationMs = result.duration_ms;
          if ("result" in result && typeof (result as Record<string, unknown>).result === "string") {
            resultText = (result as Record<string, unknown>).result as string;
          }
        }
      }
    } catch (err) {
      resultSubtype = "error_during_execution";
      this.stateStore.logHealthEvent(agentName, "session_error", String(err));
    }

    this.activeSessions.delete(sessionId);
    this.activeQueries.delete(sessionId);
    this.stateStore.updateSession(sessionId, {
      status: resultSubtype.startsWith("error") ? "failed" : "completed",
      turns,
      costUsd,
      resultSubtype,
    });

    return { sessionId, agent: agentName, result: resultText, subtype: resultSubtype, turns, costUsd, durationMs };
  }

  getActiveSession(sessionId: string): ActiveSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  getActiveSessionForAgent(agentName: string): ActiveSession | undefined {
    for (const session of this.activeSessions.values()) {
      if (session.agent === agentName) return session;
    }
    return undefined;
  }

  getAllActiveSessions(): ActiveSession[] {
    return Array.from(this.activeSessions.values());
  }

  async stopSession(sessionId: string): Promise<void> {
    const q = this.activeQueries.get(sessionId);
    if (q && "interrupt" in q) {
      try {
        await (q as unknown as { interrupt(): Promise<void> }).interrupt();
      } catch {
        // Session may already be done
      }
    }
    this.activeSessions.delete(sessionId);
    this.activeQueries.delete(sessionId);
    this.stateStore.updateSession(sessionId, { status: "completed" });
  }

  async stopAgentSession(agentName: string): Promise<void> {
    const session = this.getActiveSessionForAgent(agentName);
    if (session) {
      await this.stopSession(session.id);
    }
  }
}
