import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { log } from "../logger.js";
import type { AgentPolicy } from "../config.js";

export type ScheduleEntry = {
  label?: string;
  cron: string;
  prompt: string;
  paused?: boolean;
  freshSession?: boolean;
};

export type AgentSchedule = {
  agent: string;
  schedules: ScheduleEntry[];
};

export type SchedulerOptions = {
  startAgent: (agent: string, prompt: string) => Promise<void>;
  stopAgent: (agent: string) => Promise<void>;
  sendToPane: (agent: string, message: string) => void;
  isAgentActive: (agent: string) => boolean;
};

export class Scheduler {
  private agentSchedules: AgentSchedule[] = [];
  private options: SchedulerOptions;
  private lastFiredKey = new Set<string>();
  private agentsDir: string | null = null;
  private fileMtimes = new Map<string, number>();
  private heartbeatCount = 0;
  private reloadIntervalBeats = 10;
  constructor(options: SchedulerOptions) {
    this.options = options;
  }

  setAgentsDir(dir: string) {
    this.agentsDir = dir;
  }

  setSchedules(schedules: AgentSchedule[]) {
    this.agentSchedules = schedules;
    log().info("scheduler", `Loaded schedules for ${schedules.length} agent(s)`);
    for (const s of schedules) {
      for (const entry of s.schedules) {
        const label = entry.label ? ` [${entry.label}]` : "";
        const paused = entry.paused ? " (PAUSED)" : "";
        log().debug("scheduler", `  ${s.agent}${label}: ${entry.cron}${paused}`);
      }
    }
  }

  check() {
    this.heartbeatCount++;

    if (this.agentsDir && this.heartbeatCount % this.reloadIntervalBeats === 0) {
      this.reloadIfChanged();
    }

    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    for (const agentSched of this.agentSchedules) {
      for (const entry of agentSched.schedules) {
        if (entry.paused) continue;

        const fireKey = `${agentSched.agent}:${entry.cron}:${key}`;

        if (this.lastFiredKey.has(fireKey)) continue;
        if (!this.matchesCron(entry.cron, now)) continue;

        this.lastFiredKey.add(fireKey);

        const label = entry.label ? ` [${entry.label}]` : "";
        const active = this.options.isAgentActive(agentSched.agent);

        if (!active) {
          log().info("scheduler", `${agentSched.agent}${label}: schedule matched but agent is not running, skipping`);
          continue;
        }

        log().info("scheduler", `${agentSched.agent}${label}: firing schedule "${entry.prompt.slice(0, 60)}"`);

        if (entry.freshSession) {
          this.fireWithFreshSession(agentSched.agent, entry);
        } else {
          this.options.sendToPane(agentSched.agent, entry.prompt);
        }
      }
    }

    // Prune old keys (keep only current minute)
    for (const k of this.lastFiredKey) {
      if (!k.endsWith(key)) this.lastFiredKey.delete(k);
    }
  }

  private async fireWithFreshSession(agent: string, entry: ScheduleEntry): Promise<void> {
    const label = entry.label ? ` [${entry.label}]` : "";
    log().info("scheduler", `${agent}${label}: freshSession — stopping existing session first`);
    try {
      await this.options.stopAgent(agent);
      // Brief pause for pane cleanup
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      log().warn("scheduler", `${agent}${label}: stopAgent failed (may not have been running), proceeding with start`);
    }
    await this.options.startAgent(agent, entry.prompt);
  }

  private reloadIfChanged(): void {
    if (!this.agentsDir || !existsSync(this.agentsDir)) return;

    let changed = false;
    const currentFiles = new Set<string>();

    for (const file of readdirSync(this.agentsDir)) {
      if (!file.endsWith(".yaml")) continue;
      const filePath = join(this.agentsDir, file);
      currentFiles.add(filePath);

      try {
        const mtime = statSync(filePath).mtimeMs;
        const prevMtime = this.fileMtimes.get(filePath);
        if (prevMtime === undefined || mtime !== prevMtime) {
          changed = true;
          this.fileMtimes.set(filePath, mtime);
        }
      } catch {
        // File disappeared between readdir and stat — skip
      }
    }

    // Check for deleted files
    for (const tracked of this.fileMtimes.keys()) {
      if (!currentFiles.has(tracked)) {
        changed = true;
        this.fileMtimes.delete(tracked);
      }
    }

    if (!changed) return;

    log().info("scheduler", "YAML config change detected, reloading schedules");

    const newSchedules: AgentSchedule[] = [];
    for (const file of readdirSync(this.agentsDir)) {
      if (!file.endsWith(".yaml")) continue;
      const filePath = join(this.agentsDir, file);
      try {
        const agent = yaml.load(readFileSync(filePath, "utf-8")) as AgentPolicy;
        if (agent.schedules && agent.schedules.length > 0) {
          newSchedules.push({ agent: agent.codename, schedules: agent.schedules });
        }
      } catch (err) {
        log().warn("scheduler", `Failed to parse ${file}, keeping previous config for this agent`, {
          error: String(err),
        });
      }
    }

    this.setSchedules(newSchedules);
  }

  private matchesCron(cron: string, date: Date): boolean {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts;
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1;
    const dayOfWeek = date.getDay(); // 0=Sun

    return (
      this.matchField(minExpr, minute, 0, 59) &&
      this.matchField(hourExpr, hour, 0, 23) &&
      this.matchField(domExpr, dayOfMonth, 1, 31) &&
      this.matchField(monExpr, month, 1, 12) &&
      this.matchField(dowExpr, dayOfWeek, 0, 7)
    );
  }

  private matchField(expr: string, value: number, min: number, max: number): boolean {
    if (expr === "*") return true;

    for (const part of expr.split(",")) {
      // Step: */N or N-M/S
      if (part.includes("/")) {
        const [rangeExpr, stepStr] = part.split("/");
        const step = parseInt(stepStr, 10);
        if (isNaN(step) || step <= 0) continue;

        let start = min;
        let end = max;
        if (rangeExpr !== "*") {
          if (rangeExpr.includes("-")) {
            [start, end] = rangeExpr.split("-").map(Number);
          } else {
            start = parseInt(rangeExpr, 10);
            end = max;
          }
        }
        for (let i = start; i <= end; i += step) {
          if (i === value) return true;
        }
        continue;
      }

      // Range: N-M
      if (part.includes("-")) {
        const [startStr, endStr] = part.split("-");
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        // Handle day-of-week wrap (e.g., 5-0 doesn't make sense, but 1-5 = Mon-Fri)
        if (start <= end) {
          if (value >= start && value <= end) return true;
        } else {
          if (value >= start || value <= end) return true;
        }
        continue;
      }

      // Exact value
      if (parseInt(part, 10) === value) return true;
    }

    return false;
  }
}
