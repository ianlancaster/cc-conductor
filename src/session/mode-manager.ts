import type { StateStore } from "../engine/state-store.js";
import type { Autonomy, NudgeLevel, ActivityStatus, AgentState, PauseState } from "./types.js";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { log } from "../logger.js";

export class ModeManager {
  private agentStates = new Map<string, AgentState>();
  private pauseStates = new Map<string, PauseState>();
  private stateStore: StateStore;
  private modeStatePath: string;

  constructor(stateStore: StateStore, agents: string[], modeStatePath: string) {
    this.stateStore = stateStore;
    this.modeStatePath = modeStatePath;

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

  pauseAgent(agent: string, pausedBy: "manual" | "auto-focus"): boolean {
    const state = this.agentStates.get(agent);
    if (!state) return false;
    const existing = this.pauseStates.get(agent);
    if (existing?.paused) return false;

    this.pauseStates.set(agent, {
      paused: true,
      previousAutonomy: state.autonomy,
      previousNudgeLevel: state.nudgeLevel,
      pausedBy,
    });
    state.autonomy = "facilitated";
    this.persistState();
    log().info("mode", `${agent}: paused (was ${this.pauseStates.get(agent)!.previousAutonomy}, by ${pausedBy})`);
    return true;
  }

  resumeAgent(agent: string): boolean {
    const state = this.agentStates.get(agent);
    const pause = this.pauseStates.get(agent);
    if (!state || !pause?.paused) return false;

    state.autonomy = pause.previousAutonomy ?? "facilitated";
    state.nudgeLevel = pause.previousNudgeLevel ?? "regular";
    this.pauseStates.set(agent, { paused: false, previousAutonomy: null, previousNudgeLevel: null, pausedBy: null });
    this.persistState();
    log().info("mode", `${agent}: resumed (restored to ${state.autonomy})`);
    return true;
  }

  isPaused(agent: string): boolean {
    return this.pauseStates.get(agent)?.paused ?? false;
  }

  getPauseState(agent: string): PauseState | undefined {
    return this.pauseStates.get(agent);
  }

  getAllAgentStates(): AgentState[] {
    return Array.from(this.agentStates.values());
  }

  getStatusSummary(): string {
    const lines: string[] = [];

    for (const state of this.agentStates.values()) {
      const statusIcon = state.activityStatus === "working" ? "🟢" :
                         state.activityStatus === "stalled" ? "🟡" :
                         state.activityStatus === "awaiting_approval" ? "🔵" : "⚪";
      const modeMap: Record<string, string> = { autonomous: "auto", facilitated: "facil", approve: "approve" };
      const pause = this.pauseStates.get(state.agent);
      const mode = pause?.paused ? `paused←${modeMap[pause.previousAutonomy!] ?? pause.previousAutonomy}` : (modeMap[state.autonomy] ?? state.autonomy);
      const nudge = !pause?.paused && state.autonomy !== "facilitated" && state.nudgeLevel !== "regular" ? `,${state.nudgeLevel}` : "";
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

    try {
      writeFileSync(this.modeStatePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      log().warn("mode", `Failed to persist mode state: ${String(err)}`);
    }
  }

  private loadPersistedState(): void {
    if (!existsSync(this.modeStatePath)) return;

    try {
      const raw = readFileSync(this.modeStatePath, "utf-8");
      const data = JSON.parse(raw) as {
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
      log().info("mode", `Loaded persisted mode state for ${Object.keys(data.agents).length} agents`);
    } catch (err) {
      log().warn("mode", `Failed to load mode state (using defaults): ${String(err)}`);
    }
  }
}
