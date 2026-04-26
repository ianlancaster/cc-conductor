export type Autonomy = "facilitated" | "autonomous" | "approve";
export type NudgeLevel = "low" | "regular" | "aggressive";
export type ActivityStatus = "working" | "stalled" | "awaiting_approval" | "stopped";

export type PauseState = {
  paused: boolean;
  previousAutonomy: Autonomy | null;
  previousNudgeLevel: NudgeLevel | null;
  pausedBy: "manual" | "auto-focus" | null;
};

export type AgentState = {
  agent: string;
  autonomy: Autonomy;
  nudgeLevel: NudgeLevel;
  sessionActive: boolean;
  paneId: string | null;
  sessionId: string | null;
  talkActive: boolean;
  activityStatus: ActivityStatus;
  cognitive: boolean;
  autoObjective: string | null;
  autoStartedAt: string | null;
};

export type SessionEvent =
  | { type: "output"; agent: string; text: string }
  | { type: "completed"; agent: string; summary: string; turns: number; costUsd: number }
  | { type: "stalled"; agent: string; sessionId: string }
  | { type: "error"; agent: string; error: string };
