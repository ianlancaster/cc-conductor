import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

export type OrchestrationPolicy = {
  denyStart?: string[];
  denyStop?: string[];
  denyContinue?: string[];
  denySetAutonomy?: string[];
  denySend?: string[];
};

export type AgentPolicy = {
  agent: string;
  codename: string;
  repo: string;
  model: string;
  maxTurns: number;
  additionalDirs?: string[];
  autoApprove: {
    tools: string[];
    paths: { write: string[]; read: string[] };
    bash: { allow: string[]; deny: string[] };
  };
  escalateAlways: string[];
  peerAccess: {
    canConsult: string[];
    canReceiveFrom: string[];
  };
  orchestration?: OrchestrationPolicy;
  schedules?: {
    label?: string;
    cron: string;
    prompt: string;
    paused?: boolean;
    freshSession?: boolean;
  }[];
};

export type SupervisorConfig = {
  supervisor: {
    heartbeatIntervalSeconds: number;
    stallThresholdMinutes: number;
    stallRestartAttempts: number;
    defaultMaxTurns: number;
    logLevel: string;
    usageSessionThreshold?: number;
    usageWeeklyThreshold?: number;
  };
  intelligence: {
    stallJudgeModel: string;
  };
  autoResponses: {
    memoryPrompts: number | null;
    permissionPrompts: number | null;
    unknownNumbered: number | null;
  };
  localModel: {
    provider: string;
    model: string;
    endpoint: string;
    idleTimeoutMinutes: number;
    confidenceThreshold: number;
  };
  telegram: {
    botToken?: string;
    operatorChatId?: string;
    escalationExpiryHours: number;
    escalationDefaultAction: string;
  };
  database: {
    path: string;
  };
  claudeCode: {
    binary: string;
    defaultModel: string;
  };
  agents: Record<string, AgentPolicy>;
};

export function loadConfig(baseDir: string): SupervisorConfig {
  const supervisorPath = join(baseDir, "config", "supervisor.yaml");
  if (!existsSync(supervisorPath)) {
    throw new Error(`Supervisor config not found: ${supervisorPath}`);
  }

  const raw = yaml.load(readFileSync(supervisorPath, "utf-8")) as Record<string, unknown>;

  const rawIntelligence = (raw.intelligence ?? {}) as Record<string, unknown>;
  const rawAutoResponses = (raw.autoResponses ?? {}) as Record<string, unknown>;

  const config: SupervisorConfig = {
    supervisor: raw.supervisor as SupervisorConfig["supervisor"],
    intelligence: {
      stallJudgeModel: (rawIntelligence.stallJudgeModel as string) ?? "claude-haiku-4-5-20251001",
    },
    autoResponses: {
      memoryPrompts: (rawAutoResponses.memoryPrompts as number | null) ?? 1,
      permissionPrompts: (rawAutoResponses.permissionPrompts as number | null) ?? 1,
      unknownNumbered: (rawAutoResponses.unknownNumbered as number | null) ?? null,
    },
    localModel: raw.localModel as SupervisorConfig["localModel"],
    telegram: {
      ...(raw.telegram as Record<string, unknown>),
      botToken: process.env.CONDUCTOR_TELEGRAM_TOKEN,
      operatorChatId: process.env.CONDUCTOR_TELEGRAM_CHAT_ID,
    } as SupervisorConfig["telegram"],
    database: raw.database as SupervisorConfig["database"],
    claudeCode: raw.claudeCode as SupervisorConfig["claudeCode"],
    agents: {},
  };

  const agentsDir = join(baseDir, "config", "agents");
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith(".yaml")) continue;
      const agent = yaml.load(
        readFileSync(join(agentsDir, file), "utf-8")
      ) as AgentPolicy;
      config.agents[agent.codename] = agent;
    }
  }

  return config;
}
