import type { StateStore } from "../engine/state-store.js";
import type { Autonomy, NudgeLevel, ActivityStatus, AgentState } from "./types.js";

export class ModeManager {
  private agentStates = new Map<string, AgentState>();
  private stateStore: StateStore;

  constructor(stateStore: StateStore, agents: string[]) {
    this.stateStore = stateStore;

    for (const agent of agents) {
      this.agentStates.set(agent, {
        agent,
        autonomy: "facilitated",
        nudgeLevel: "regular",
        sessionActive: false,
        paneId: null,
        sessionId: null,
        talkActive: false,
        activityStatus: "stopped",
        cognitive: false,
        autoObjective: null,
        autoStartedAt: null,
      });
    }

    this.loadPersistedState();
  }

  addAgent(agent: string): void {
    if (this.agentStates.has(agent)) return;
    this.agentStates.set(agent, {
      agent,
      autonomy: "facilitated",
      nudgeLevel: "regular",
      sessionActive: false,
      paneId: null,
      sessionId: null,
      talkActive: false,
      activityStatus: "stopped",
      cognitive: false,
      autoObjective: null,
      autoStartedAt: null,
    });
  }

  removeAgent(agent: string): void {
    this.agentStates.delete(agent);
  }

  getAutonomy(agent: string): Autonomy {
    return this.agentStates.get(agent)?.autonomy ?? "facilitated";
  }

  setAutonomy(agent: string, autonomy: Autonomy): void {
    const state = this.agentStates.get(agent);
    if (state) {
      state.autonomy = autonomy;
      this.persistState();
    }
  }

  getNudgeLevel(agent: string): NudgeLevel {
    return this.agentStates.get(agent)?.nudgeLevel ?? "regular";
  }

  setNudgeLevel(agent: string, level: NudgeLevel): void {
    const state = this.agentStates.get(agent);
    if (state) {
      state.nudgeLevel = level;
      this.persistState();
    }
  }

  getActivityStatus(agent: string): ActivityStatus {
    return this.agentStates.get(agent)?.activityStatus ?? "stopped";
  }

  setActivityStatus(agent: string, status: ActivityStatus): void {
    const state = this.agentStates.get(agent);
    if (state) {
      state.activityStatus = status;
    }
  }

  isCognitive(agent: string): boolean {
    return this.agentStates.get(agent)?.cognitive ?? false;
  }

  setCognitive(agent: string, cognitive: boolean): void {
    const state = this.agentStates.get(agent);
    if (state) state.cognitive = cognitive;
  }

  setAutoObjective(agent: string, objective: string | null): void {
    const state = this.agentStates.get(agent);
    if (state) {
      state.autoObjective = objective;
      state.autoStartedAt = objective ? new Date().toISOString() : null;
      this.persistState();
    }
  }

  getAutoObjective(agent: string): string | null {
    return this.agentStates.get(agent)?.autoObjective ?? null;
  }

  getAgentState(agent: string): AgentState | undefined {
    return this.agentStates.get(agent);
  }

  setSessionActive(agent: string, active: boolean, sessionId?: string, paneId?: string): void {
    const state = this.agentStates.get(agent);
    if (state) {
      state.sessionActive = active;
      state.sessionId = sessionId ?? null;
      state.paneId = paneId ?? null;
      this.persistState();
    }
  }

  setTalkActive(agent: string, active: boolean): void {
    if (active) {
      for (const state of this.agentStates.values()) {
        state.talkActive = false;
      }
    }
    const state = this.agentStates.get(agent);
    if (state) {
      state.talkActive = active;
    }
  }

  getTalkTarget(): string | null {
    for (const state of this.agentStates.values()) {
      if (state.talkActive) return state.agent;
    }
    return null;
  }

  getAllAgentStates(): AgentState[] {
    return Array.from(this.agentStates.values());
  }

  getStatusSummary(): string {
    const lines: string[] = [];

    for (const state of this.agentStates.values()) {
      const statusIcon = state.activityStatus === "working" ? "🟢" :
                         state.activityStatus === "stalled" ? "🟡" :
                         state.activityStatus === "awaiting_approval" ? "🔵" :
                         state.activityStatus === "wrapping_up" ? "🟠" : "⚪";
      const modeMap: Record<string, string> = { autonomous: "auto", facilitated: "facil", approve: "approve" };
      const mode = modeMap[state.autonomy] ?? state.autonomy;
      const nudge = state.nudgeLevel !== "regular" ? `,${state.nudgeLevel}` : "";
      lines.push(`${state.agent}: ${statusIcon} ${state.activityStatus} (${mode}${nudge})`);
    }

    return lines.join(" | ");
  }

  private persistState(): void {
    const data = {
      agents: Object.fromEntries(
        Array.from(this.agentStates.entries()).map(([k, v]) => [
          k,
          {
            autonomy: v.autonomy,
            nudgeLevel: v.nudgeLevel,
            autoObjective: v.autoObjective,
            autoStartedAt: v.autoStartedAt,
          },
        ])
      ),
    };

    this.stateStore.logHealthEvent(
      "conductor",
      "mode_state_saved",
      JSON.stringify(data)
    );
  }

  private loadPersistedState(): void {
    const events = this.stateStore.getHealthLog("conductor", 1);
    const latest = events.find((e) => e.event === "mode_state_saved");
    if (!latest?.detail) return;

    try {
      const data = JSON.parse(latest.detail) as {
        agents: Record<string, {
          autonomy: Autonomy;
          nudgeLevel?: NudgeLevel;
          autoObjective?: string | null;
          autoStartedAt?: string | null;
        }>;
      };
      for (const [agent, settings] of Object.entries(data.agents)) {
        const state = this.agentStates.get(agent);
        if (state) {
          state.autonomy = settings.autonomy;
          state.nudgeLevel = settings.nudgeLevel ?? "regular";
          state.autoObjective = settings.autoObjective ?? null;
          state.autoStartedAt = settings.autoStartedAt ?? null;
        }
      }
    } catch {
      // Corrupted state — use defaults
    }
  }
}
