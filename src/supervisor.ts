import { loadConfig, loadAgentConfigs, type SupervisorConfig } from "./config.js";
import { StateStore } from "./engine/state-store.js";
import { PermissionEngine } from "./engine/permission-engine.js";
import { HealthMonitor } from "./engine/health-monitor.js";
import { EscalationQueue } from "./engine/escalation-queue.js";
import { IterminalWorkspace } from "./transport/iterm.js";
import { TelegramTransport } from "./transport/telegram.js";
import { AgentSession } from "./session/agent-session.js";

import { ModeManager } from "./session/mode-manager.js";
import { ConductorMcpServer } from "./mcp/server.js";
import { buildMcpTools } from "./mcp/tools.js";
import { StallJudge, stripTerminalChrome, detectNumberedOptions } from "./intelligence/stall-judge.js";
import { checkOrchestrationPolicy } from "./engine/orchestration-policy.js";
import { Scheduler } from "./engine/scheduler.js";
import { initLogger, log } from "./logger.js";
import { resolve, join } from "path";
import { writeFileSync, existsSync } from "fs";

export type AgentStatusReport = {
  codename: string;
  domain: string;
  status: "active" | "idle";
  autonomy: "autonomous" | "facilitated" | "approve";
  nudgeLevel: "low" | "regular" | "aggressive";
  activityStatus: "working" | "stalled" | "awaiting_approval" | "wrapping_up" | "stopped";
  cognitive: boolean;
  sessionId: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  stallCount: number;
  pendingEscalations: number;
};

export class Supervisor {
  private config: SupervisorConfig;
  private stateStore: StateStore;
  private permissionEngine: PermissionEngine;
  private healthMonitor: HealthMonitor;
  private escalationQueue: EscalationQueue;
  private workspace: IterminalWorkspace;
  private telegram: TelegramTransport | null = null;
  private modeManager: ModeManager;

  private stallJudge: StallJudge;
  private scheduler: Scheduler;
  private mcpServer: ConductorMcpServer;
  private agentSessions = new Map<string, AgentSession>();
  private pendingCustomReplyId: number | null = null;
  private pendingApprovals = new Map<number, {
    agent: string;
    action: "send_to_agent" | "respond_to_user";
    target: string;
    message: string;
  }>();
  private mcpConfigPath: string;
  private systemPromptPath: string;
  private cognitivePromptPath: string;
  private agentsDir: string;
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.config = loadConfig(baseDir);
    this.agentsDir = resolve(baseDir, "config", "agents");

    const logLevel = (this.config.supervisor.logLevel ?? "info") as "debug" | "info" | "warn" | "error";
    initLogger(logLevel, resolve(baseDir, "data", "conductor.log"));

    log().info("supervisor", "Initializing Agent Conductor v1.0");

    const dbPath = resolve(baseDir, this.config.database.path);
    this.stateStore = new StateStore(dbPath);
    log().debug("supervisor", "State store opened", { path: dbPath });

    this.permissionEngine = new PermissionEngine();

    const agentNames = Object.keys(this.config.agents);
    log().info("supervisor", `Agents configured: ${agentNames.join(", ")}`, { count: agentNames.length });

    this.modeManager = new ModeManager(this.stateStore, agentNames);
    log().info("supervisor", `Agents configured: ${agentNames.length}`);

    const itermConfig = (this.config as Record<string, unknown>).iterm as Record<string, unknown> | undefined;
    this.workspace = new IterminalWorkspace({
      windowName: (itermConfig?.windowName as string) ?? "Agent Conductor",
      statePath: resolve(baseDir, "data", "workspace.json"),
    });

    this.stallJudge = new StallJudge(this.config.intelligence.stallJudgeModel);

    this.scheduler = new Scheduler({
      startAgent: (agent, prompt) => this.startAgent(agent, prompt),
      stopAgent: (agent) => this.stopAgent(agent),
      isAgentActive: (agent) => {
        const state = this.modeManager.getAgentState(agent);
        return !!state?.sessionActive && this.workspace.isPaneAlive(agent);
      },
    });

    // Set agents dir for hot-reload (re-reads YAMLs every ~5 min)
    this.scheduler.setAgentsDir(resolve(baseDir, "config", "agents"));

    // Load schedules from agent configs
    const agentSchedules = Object.values(this.config.agents)
      .filter((a) => a.schedules && a.schedules.length > 0)
      .map((a) => ({ agent: a.codename, schedules: a.schedules! }));
    this.scheduler.setSchedules(agentSchedules);

    this.healthMonitor = new HealthMonitor({
      heartbeatIntervalSeconds: this.config.supervisor.heartbeatIntervalSeconds,
      stallBeatsThreshold: 1,
      capturePane: (agent, lines) => this.workspace.capturePane(agent, lines),
      getActiveAgents: () => {
        return Object.keys(this.config.agents).filter((a) => {
          const state = this.modeManager.getAgentState(a);
          return state?.sessionActive;
        });
      },
      onStall: (agent, paneContent) => {
        this.handleStallDetection(agent, paneContent);
      },
      onWorking: (agent) => {
        this.modeManager.setActivityStatus(agent, "working");
      },
      logHealthEvent: (agent, event, detail) => {
        log().warn("health", `${agent}: ${event}`, { detail });
        this.stateStore.logHealthEvent(agent, event, detail);
      },
    });

    const sendTelegram = async (text: string, buttons?: { text: string; callback_data: string }[][]) => {
      if (this.telegram) {
        log().debug("telegram", `Sending message (${text.length} chars)`, { hasButtons: !!buttons });
        await this.telegram.send(text, buttons);
      } else {
        log().debug("telegram", `[not connected] ${text.slice(0, 100)}`);
      }
    };

    this.escalationQueue = new EscalationQueue({
      sendTelegram,
      getPendingEscalations: () => this.stateStore.getPendingEscalations(),
      resolveEscalation: (id, status, resolvedBy, note) => {
        log().info("escalation", `#${id} ${status} by ${resolvedBy}`, { note });
        this.stateStore.resolveEscalation(id, status, resolvedBy, note);
        if (status === "approved") this.executePendingApproval(id, note);
        if (status === "denied") this.denyPendingApproval(id);
      },
      insertEscalation: (params) => {
        log().warn("escalation", `New escalation: ${params.agent} → ${params.actionType}`, {
          detail: params.actionDetail?.slice(0, 100),
          reason: params.agentContext,
        });
        this.stateStore.insertEscalation(params);
      },
      expiryHours: this.config.telegram.escalationExpiryHours,
      defaultAction: this.config.telegram.escalationDefaultAction,
    });

    const mcpConfig = (this.config as Record<string, unknown>).mcp as Record<string, unknown> | undefined;
    const mcpPort = (mcpConfig?.port as number) ?? 3456;
    this.mcpConfigPath = resolve(baseDir, "data", "conductor-mcp.json");
    this.systemPromptPath = resolve(baseDir, "config", "system-prompt-base.txt");
    this.cognitivePromptPath = resolve(baseDir, "config", "system-prompt-cognitive.txt");

    const mcpTools = buildMcpTools({
      notifyAgents: (message, recipients) => this.handleNotification(message, recipients),
      broadcastToAgents: (from, message) => this.broadcastToAgents(from, message),
      requestHumanInput: (from, question, context, options) =>
        this.handleHumanInputRequest(from, question, context, options),
      respondToUser: (from, message) => this.handleUserResponse(from, message),

      startAgent: (codename, prompt) => this.startAgent(codename, prompt),
      stopAgent: (codename) => this.stopAgent(codename),
      continueAgent: (codename) => this.continueAgent(codename),
      setAutonomy: (codename, autonomy) => this.setAutonomy(codename, autonomy),
      sendToAgent: (codename, message) => this.sendToAgent(codename, message),

      requestContext: (codename) => this.requestContext(codename),
      requestRestart: (codename, reason) => this.requestRestart(codename, reason),

      listAgents: () => this.listAgents(),
      getAgentStatus: (codename) => this.getAgentStatus(codename),
      listEscalations: () =>
        this.stateStore.getPendingEscalations().map((e) => ({
          id: e.id,
          agent: e.agent,
          actionType: e.action_type,
          actionDetail: e.action_detail,
          createdAt: e.created_at,
        })),

      checkOrchestrationPolicy: (sender, verb, target) =>
        this.checkOrchestrationPolicy(sender, verb, target),

      agentExists: (codename) => !!this.config.agents[codename],
    });

    this.mcpServer = new ConductorMcpServer({ port: mcpPort, tools: mcpTools });

    writeFileSync(
      this.mcpConfigPath,
      JSON.stringify(
        { mcpServers: { conductor: { type: "http", url: `http://localhost:${mcpPort}/mcp` } } },
        null,
        2
      )
    );
    log().debug("supervisor", `MCP config written to ${this.mcpConfigPath}`);
  }

  async start(opts?: { startAll?: boolean }): Promise<void> {
    log().info("supervisor", "Starting...");

    this.workspace.createWorkspace();
    log().info("iterm", "iTerm2 workspace created");

    // Mark rediscovered agents (survived restart) as active
    for (const agent of this.workspace.getRediscoveredAgents()) {
      this.modeManager.setSessionActive(agent, true);
      this.modeManager.setActivityStatus(agent, "working");
      log().info("supervisor", `${agent}: restored as active (rediscovered pane)`);
    }

    await this.mcpServer.start();
    log().info("mcp", `Server listening on localhost:${this.mcpServer.getPort()}`);

    if (this.config.telegram.botToken && this.config.telegram.operatorChatId) {
      this.telegram = new TelegramTransport(
        { botToken: this.config.telegram.botToken, chatId: this.config.telegram.operatorChatId },
        {
          onCommand: (cmd, args) => this.handleTelegramCommand(cmd, args),
          onAgentMessage: (agent, text) => this.handleAgentMessage(agent, text),
          onFreeText: (text) => this.handleFreeText(text),
        }
      );
      log().info("telegram", "Bot connected and polling");
    } else {
      log().warn("telegram", "Not configured — escalations will log only");
    }

    this.healthMonitor.startHeartbeat();
    // Scheduler and agent-config hot-reload piggyback on the same heartbeat interval
    setInterval(() => {
      this.scheduler.check();
      this.reloadAgentConfigs();
    }, this.config.supervisor.heartbeatIntervalSeconds * 1000);
    log().info("health", `Heartbeat started (${this.config.supervisor.heartbeatIntervalSeconds}s interval)`);

    log().info("intelligence", "Stall judge ready (Claude API)");

    // System pane for usage monitoring
    this.workspace.createSystemPane();
    // First check after 30s (let claude boot), then every 5 minutes
    setTimeout(() => {
      this.checkUsage();
      setInterval(() => this.checkUsage(), 5 * 60 * 1000);
    }, 30_000);
    log().info("usage", "Usage monitor started (first check in 30s, then 5m interval)");

    this.updateStatus();
    log().info("supervisor", "Agent Conductor ready");

    if (opts?.startAll) {
      const agents = Object.keys(this.config.agents);
      log().info("supervisor", `Starting all ${agents.length} agents...`);
      for (const agentName of agents) {
        this.startAgent(agentName);
      }
    }
  }

  async stop(): Promise<void> {
    log().info("supervisor", "Shutting down (agents left running)...");
    this.healthMonitor.stopHeartbeat();
    this.telegram?.stop();
    this.mcpServer.stop();

    this.stateStore.close();
    log().info("supervisor", "Shutdown complete");
  }

  async continueAgent(agentName: string): Promise<void> {
    const policy = this.config.agents[agentName];
    if (!policy) {
      log().error("session", `Cannot continue unknown agent: ${agentName}`);
      return;
    }

    const cognitive = existsSync(join(policy.repo, ".cognitive-agent"));
    this.modeManager.setCognitive(agentName, cognitive);

    log().info("session", `Resuming ${agentName}`, { repo: policy.repo, cognitive });

    const session = new AgentSession({
      workspace: this.workspace,
      policy,
      stateStore: this.stateStore,
      mcpConfigPath: this.mcpConfigPath,
      systemPromptPath: this.systemPromptPath,
      cognitivePromptPath: this.cognitivePromptPath,
      cognitive,
    });

    const sessionId = session.continue();
    this.agentSessions.set(agentName, session);
    this.modeManager.setSessionActive(agentName, true, sessionId);
    this.modeManager.setActivityStatus(agentName, "working");
    this.healthMonitor.resetAgent(agentName);

    log().info("session", `${agentName}: resumed`, { sessionId: sessionId.slice(0, 8) });
    this.updateStatus();
  }

  async startAgent(agentName: string, prompt?: string): Promise<void> {
    const policy = this.config.agents[agentName];
    if (!policy) {
      log().error("session", `Cannot start unknown agent: ${agentName}`);
      return;
    }

    // Liveness check: if we think the agent is active, verify the pane exists
    const state = this.modeManager.getAgentState(agentName);
    if (state?.sessionActive) {
      if (this.workspace.isPaneAlive(agentName)) {
        log().info("session", `${agentName}: already running, skipping start`);
        return;
      }
      log().info("session", `${agentName}: was marked active but pane is dead, restarting`);
      this.modeManager.setSessionActive(agentName, false);
      this.agentSessions.delete(agentName);
    }

    const cognitive = existsSync(join(policy.repo, ".cognitive-agent"));
    this.modeManager.setCognitive(agentName, cognitive);

    const autonomy = this.modeManager.getAutonomy(agentName);
    log().info("session", `Starting ${agentName}`, {
      autonomy, cognitive, repo: policy.repo, prompt: prompt?.slice(0, 80),
    });

    const session = new AgentSession({
      workspace: this.workspace,
      policy,
      stateStore: this.stateStore,
      mcpConfigPath: this.mcpConfigPath,
      systemPromptPath: this.systemPromptPath,
      cognitivePromptPath: this.cognitivePromptPath,
      cognitive,
    });

    const sessionId = prompt ? session.start(prompt) : session.start();

    this.agentSessions.set(agentName, session);
    this.modeManager.setSessionActive(agentName, true, sessionId);
    this.modeManager.setActivityStatus(agentName, "working");
    this.healthMonitor.resetAgent(agentName);

    log().info("session", `${agentName}: session started`, {
      sessionId: sessionId.slice(0, 8), autonomy,
    });
    this.updateStatus();
  }

  async stopAgent(agentName: string): Promise<void> {
    const policy = this.config.agents[agentName];
    if (!policy) {
      log().error("session", `Cannot stop unknown agent: ${agentName}`);
      return;
    }

    log().info("session", `Stopping ${agentName}`);
    const session = this.agentSessions.get(agentName);
    if (session) {
      session.stop();
      this.agentSessions.delete(agentName);
    } else {
      // No session object (e.g., after conductor restart) — kill pane directly
      this.workspace.killAgentPane(agentName);
    }
    this.modeManager.setSessionActive(agentName, false);
    this.modeManager.setActivityStatus(agentName, "stopped");
    this.updateStatus();
  }

  setAutonomy(agentName: string, autonomy: "autonomous" | "facilitated" | "approve"): void {
    const policy = this.config.agents[agentName];
    if (!policy) {
      log().error("mode", `Cannot set autonomy for unknown agent: ${agentName}`);
      return;
    }
    log().info("mode", `${agentName} → ${autonomy}`);
    this.modeManager.setAutonomy(agentName, autonomy);
  }

  async sendToAgent(agentName: string, message: string): Promise<void> {
    const policy = this.config.agents[agentName];
    if (!policy) {
      log().error("message", `Cannot send to unknown agent: ${agentName}`);
      return;
    }
    await this.handleAgentMessage(agentName, message);
  }

  listAgents(): AgentStatusReport[] {
    return Object.keys(this.config.agents).map((codename) => this.getAgentStatus(codename));
  }

  getAgentStatus(agentName: string): AgentStatusReport {
    const policy = this.config.agents[agentName];
    const state = this.modeManager.getAgentState(agentName);

    // Liveness probe: if mode manager says active but pane is dead, correct
    if (state?.sessionActive && !this.workspace.isPaneAlive(agentName)) {
      log().info("supervisor", `${agentName}: pane dead, correcting state to idle`);
      this.modeManager.setSessionActive(agentName, false);
      this.agentSessions.delete(agentName);
    }

    const correctedState = this.modeManager.getAgentState(agentName);
    const stallCount = this.healthMonitor.getStallCount(agentName);
    const lastActivityAt = null;
    const pendingEscalations = this.stateStore
      .getPendingEscalations()
      .filter((e) => e.agent === agentName).length;

    // Derive activity status with corrections
    let activityStatus = correctedState?.activityStatus ?? "stopped";

    // Fix stale "stopped" for agents that are actually running
    if (correctedState?.sessionActive && activityStatus === "stopped") {
      activityStatus = "working";
      this.modeManager.setActivityStatus(agentName, "working");
    }

    // Fix stale status for agents that are no longer running
    if (!correctedState?.sessionActive && activityStatus !== "stopped") {
      activityStatus = "stopped";
      this.modeManager.setActivityStatus(agentName, "stopped");
    }

    // Override with awaiting_approval if there are pending escalations
    if (pendingEscalations > 0 && activityStatus !== "stopped") {
      activityStatus = "awaiting_approval";
      this.modeManager.setActivityStatus(agentName, "awaiting_approval");
    }

    return {
      codename: agentName,
      domain: policy?.agent ?? agentName,
      status: correctedState?.sessionActive ? "active" : "idle",
      autonomy: correctedState?.autonomy ?? "facilitated",
      nudgeLevel: correctedState?.nudgeLevel ?? "regular",
      activityStatus,
      cognitive: correctedState?.cognitive ?? false,
      sessionId: state?.sessionId ?? null,
      startedAt: null,
      lastActivityAt,
      stallCount,
      pendingEscalations,
    };
  }

  // ── Context management ──────────────────────────────────────────────

  async requestContext(agentName: string): Promise<string> {
    log().info("context", `${agentName}: context check requested`);
    // Return immediately so the agent can end its turn and unblock the pane.
    // The /context command and result delivery happen asynchronously.
    this.deliverContext(agentName);
    return "Context check queued. End your turn now — the result will arrive as a follow-up message.";
  }

  private async deliverContext(agentName: string): Promise<void> {
    // Wait for the agent to finish its turn so the pane accepts input
    await this.sleep(2000);
    this.workspace.runInPane(agentName, "/context");
    await this.sleep(1500);
    this.workspace.runInPane(agentName, "[Context check complete] Your context usage is displayed above. Report what you see.");
  }


  async requestRestart(agentName: string, reason: string): Promise<string> {
    log().info("context", `${agentName}: restart requested — ${reason}`);
    // Return immediately so the agent can end its turn
    this.executeRestart(agentName);
    return "Restart queued. End your turn now — your session will be torn down and restarted.";
  }

  // ── Approve mode ──────────────────────────────────────────────────────

  async queueForApproval(params: {
    agent: string;
    action: "send_to_agent" | "respond_to_user";
    target: string;
    message: string;
  }): Promise<string> {
    const { agent, action, target, message } = params;
    log().info("approve", `${agent}: queuing ${action} → ${target} for approval`);

    this.stateStore.insertEscalation({
      agent,
      sessionId: null,
      actionType: action,
      actionDetail: JSON.stringify({ target, message }),
      agentContext: `Approve mode: ${agent} wants to ${action === "respond_to_user" ? "message the operator" : `message ${target}`}`,
    });

    const pending = this.stateStore.getPendingEscalations();
    const latest = pending[pending.length - 1];
    const id = latest?.id ?? 0;

    this.pendingApprovals.set(id, params);

    const preview = message.length > 200 ? message.slice(0, 200) + "…" : message;
    const text = [
      `🔒 Approve mode — ${agent}`,
      "",
      action === "respond_to_user"
        ? `Wants to message you:`
        : `Wants to message ${target}:`,
      "",
      preview,
    ].join("\n");

    const buttons = [
      [
        { text: "✅ Approve", callback_data: `approve:${id}` },
        { text: "❌ Deny", callback_data: `deny:${id}` },
      ],
    ];

    if (this.telegram) {
      await this.telegram.send(text, buttons);
    }

    return `Message queued for operator approval (escalation #${id}). It will be delivered if approved.`;
  }

  private executePendingApproval(id: number, customResponse?: string): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);

    const { target, message } = pending;
    const delivery = customResponse || message;
    log().info("approve", `#${id} approved → ${target}`, { custom: !!customResponse });

    if (pending.action === "send_to_agent") {
      const prefix = customResponse ? "[Approved — custom]" : "[Approved]";
      this.workspace.runInPane(target, `${prefix} ${delivery}`);
    }
  }

  private denyPendingApproval(id: number): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    log().info("approve", `#${id} denied: ${pending.agent}`);
  }

  private async executeRestart(agentName: string): Promise<void> {
    await this.sleep(3000);
    if (this.isCognitiveAgent(agentName)) {
      this.workspace.runInPane(agentName, "/sleep");
      await this.sleep(30_000);
    }
    await this.stopAgent(agentName);
    await this.sleep(1000);
    const startPrompt = this.isCognitiveAgent(agentName) ? "/caffeinate" : undefined;
    await this.startAgent(agentName, startPrompt);
    log().info("context", `${agentName}: restart complete`);
  }

  private rateLimitPaused = false;

  private checkUsage(): void {
    const usage = this.workspace.checkUsage();
    if (!usage) return;

    log().info("usage", `Session: ${usage.session}% (resets ${usage.sessionReset}) | Weekly: ${usage.weekly}% (resets ${usage.weeklyReset})`);

    const sessionThreshold = this.config.supervisor.usageSessionThreshold ?? 80;
    const weeklyThreshold = this.config.supervisor.usageWeeklyThreshold ?? 70;

    if ((usage.session >= sessionThreshold || usage.weekly >= weeklyThreshold) && !this.rateLimitPaused) {
      this.rateLimitPaused = true;
      const reason = usage.session >= sessionThreshold
        ? `Session at ${usage.session}% (resets ${usage.sessionReset})`
        : `Weekly at ${usage.weekly}% (resets ${usage.weeklyReset})`;

      log().warn("usage", `Rate limit threshold hit: ${reason}. Pausing agents.`);
      this.telegram?.send(`⚠️ Rate limit warning: ${reason}. Pausing all agents.`);

      // Send pause to all active agents
      for (const agent of Object.keys(this.config.agents)) {
        const state = this.modeManager.getAgentState(agent);
        if (state?.sessionActive) {
          const msg = this.isCognitiveAgent(agent)
            ? "[RATE LIMIT] Usage approaching limit. Please /nap and stand by. The conductor will resume you when usage resets."
            : "[RATE LIMIT] Usage approaching limit. Save your work and stand by. The conductor will resume you when usage resets.";
          this.workspace.runInPane(agent, msg);
        }
      }
    }

    if (usage.session < sessionThreshold && usage.weekly < weeklyThreshold && this.rateLimitPaused) {
      this.rateLimitPaused = false;
      log().info("usage", "Usage back under threshold. Resuming agents.");
      this.telegram?.send("✅ Rate limit cleared. Agents may resume.");

      for (const agent of Object.keys(this.config.agents)) {
        const state = this.modeManager.getAgentState(agent);
        if (state?.sessionActive) {
          this.workspace.runInPane(agent, "[RATE LIMIT CLEARED] Usage has reset. You may resume work.");
        }
      }
    }
  }

  private reloadAgentConfigs(): void {
    const freshAgents = loadAgentConfigs(this.agentsDir);
    const currentNames = new Set(Object.keys(this.config.agents));
    const freshNames = new Set(Object.keys(freshAgents));

    // Detect new agents
    for (const name of freshNames) {
      if (!currentNames.has(name)) {
        this.config.agents[name] = freshAgents[name];
        this.modeManager.addAgent(name);
        log().info("supervisor", `Hot-reload: new agent registered — ${name}`);
        this.updateStatus();
      }
    }

    // Detect removed agents (only if not currently active)
    for (const name of currentNames) {
      if (!freshNames.has(name)) {
        const state = this.modeManager.getAgentState(name);
        if (state?.sessionActive) {
          log().warn("supervisor", `Hot-reload: ${name} config removed but session active — keeping`);
          continue;
        }
        delete this.config.agents[name];
        this.modeManager.removeAgent(name);
        log().info("supervisor", `Hot-reload: agent deregistered — ${name}`);
        this.updateStatus();
      }
    }
  }

  async handleCliCommand(input: string): Promise<string> {
    // Parse /command args — same format as Telegram
    if (input.startsWith("/")) {
      const spaceIdx = input.indexOf(" ");
      const command = spaceIdx === -1 ? input : input.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? "" : input.slice(spaceIdx + 1);
      return this.handleTelegramCommand(command, args);
    }

    // Bare text → route to talk target (same as Telegram free text)
    return (await this.handleFreeText(input)) ?? "";
  }

  isCognitiveAgent(agent: string): boolean {
    return this.modeManager.isCognitive(agent);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  checkOrchestrationPolicy(
    sender: string,
    verb: "start" | "stop" | "continue" | "setAutonomy" | "send",
    target: string
  ): { allowed: boolean; reason?: string } {
    return checkOrchestrationPolicy(
      sender,
      verb,
      target,
      this.config.agents[sender]?.orchestration
    );
  }

  private async handleStallDetection(agent: string, captured: string): Promise<void> {
    const autonomy = this.modeManager.getAutonomy(agent);
    const nudgeLevel = this.modeManager.getNudgeLevel(agent);

    // 0. Facilitated mode: operator is driving, ignore ALL stalls.
    // This check MUST be first — facilitated agents should never receive
    // auto-responses, compaction nudges, or post-sleep restarts from the conductor.
    if (autonomy === "facilitated") {
      log().debug("health", `${agent}: idle at prompt (facilitated) — not a stall`);
      return;
    }

    // 1. Numbered option detection (memory prompts, permission prompts, etc.)
    // These block agents completely. Respond with bare number, no prefix.
    const optionCheck = detectNumberedOptions(captured, this.config.autoResponses);
    if (optionCheck.detected) {
      log().info("health", `${agent}: numbered option detected (${optionCheck.pattern}), responding: ${optionCheck.response}`);
      this.workspace.runInPane(agent, optionCheck.response);
      this.telegram?.send(`🔢 *${agent}* — auto-responded to ${optionCheck.pattern} prompt with "${optionCheck.response}"`);
      return;
    }

    // 2. Post-sleep detection (cognitive agents only)
    if (this.isCognitiveAgent(agent)) {
      const sleepMarkers = [
        /checkpoint: session/i,
        /Water [Cc]ooler.*(?:bulletin|posted)/i,
        /What was documented/i,
        /Next actions/i,
        /Session \d+ — Sleep Summary/i,
      ];
      const napMarkers = [
        /^nap:/im,
        /Good checkpoint/i,
      ];
      const isSleepComplete = sleepMarkers.filter(p => p.test(captured)).length >= 2;
      const isNapOnly = napMarkers.some(p => p.test(captured)) && !isSleepComplete;

      if (isSleepComplete && !isNapOnly) {
        log().info("health", `${agent}: post-sleep detected, restarting with /caffeinate`);
        this.telegram?.send(`🔄 *${agent}* completed /sleep. Restarting with /caffeinate.`);
        await this.stopAgent(agent);
        await this.sleep(1000);
        await this.startAgent(agent, "/caffeinate");
        log().info("health", `${agent}: post-sleep restart complete`);
        return;
      }
    }

    // 3. Post-compaction nudge
    if (captured.match(/compacted|Compacted/i)) {
      log().info("health", `${agent}: post-compaction detected, sending resumption nudge`);
      const nudge = this.isCognitiveAgent(agent)
        ? [
            "[Auto-compaction detected]",
            "Your context was auto-compacted. Re-orient from your cognitive files",
            "(context/current-state.md, context/active-priorities.md) and continue",
            "where you left off. Check your most recent journal entry for task state.",
          ].join("\n")
        : "[Auto-compaction detected] Your context was auto-compacted. Re-read any relevant files and continue where you left off.";
      this.workspace.runInPane(agent, nudge);
      return;
    }

    // 3. Auto/approve mode: single API call to classify + draft
    log().info("health", `${agent}: stall detected (${autonomy}, nudge=${nudgeLevel}), judging...`);
    this.modeManager.setActivityStatus(agent, "stalled");
    const judgment = await this.stallJudge.judge(agent, captured, nudgeLevel);
    log().info("health", `${agent}: ${judgment.status}`, { reasoning: judgment.reasoning, draft: judgment.draft?.slice(0, 100) });

    if (judgment.status === "idle") {
      log().debug("health", `${agent}: idle, no nudge needed`);
      return;
    }

    const draftText = judgment.draft || "(Could not draft a response — needs your input)";
    const cleaned = stripTerminalChrome(captured);
    const panePreview = cleaned.split("\n").slice(-20).join("\n");

    if (autonomy === "autonomous") {
      // Auto mode: deliver directly + send audit trail to operator
      if (judgment.draft) {
        log().info("health", `${agent}: auto-nudging`);
        this.workspace.runInPane(agent, `[Auto] ${judgment.draft}`);
        this.telegram?.send([
          `🤖 *${agent}* — auto-nudged:`,
          "",
          `*Agent output:*`,
          "```",
          panePreview,
          "```",
          "",
          `*Conductor responded:*`,
          judgment.draft,
        ].join("\n"));
      } else {
        log().warn("health", `${agent}: draft failed, escalating to operator`);
        this.telegram?.send(`⚠️ ${agent} is stalled and auto-response failed. Manual nudge needed.\n\n\`\`\`\n${panePreview}\n\`\`\``);
      }
      return;
    }

    // Approve mode: show operator the actual pane content + draft for sign-off
    this.stateStore.insertEscalation({
      agent,
      sessionId: null,
      actionType: "stall_nudge",
      actionDetail: JSON.stringify({ draft: draftText, panePreview }),
      agentContext: judgment.reasoning,
    });

    const pending = this.stateStore.getPendingEscalations();
    const latest = pending[pending.length - 1];
    const id = latest?.id ?? 0;

    this.pendingApprovals.set(id, {
      agent,
      action: "send_to_agent",
      target: agent,
      message: draftText,
    });

    const text = [
      `🔒 *${agent}* is stalled (approve mode):`,
      "",
      `*Agent output:*`,
      "```",
      panePreview,
      "```",
      "",
      `*Conductor would respond:*`,
      draftText,
    ].join("\n");

    const buttons = [
      [
        { text: "✅ Send it", callback_data: `approve:${id}` },
        { text: "❌ Don't nudge", callback_data: `deny:${id}` },
      ],
      [{ text: "✏️ Custom nudge", callback_data: `custom:${id}` }],
    ];

    this.telegram?.send(text, buttons);
  }

  private async handleUserResponse(from: string, message: string): Promise<string> {
    log().info("mcp", `${from} → user (${message.length} chars)`);
    if (this.telegram) {
      await this.telegram.send(`*${from}:*\n${message.trim()}`);
    } else {
      console.log(`[${from}]: ${message}`);
    }
    return "Delivered to user.";
  }

  private async broadcastToAgents(from: string, message: string): Promise<string> {
    const allAgents = Object.keys(this.config.agents);
    const results: string[] = [];

    for (const agent of allAgents) {
      if (agent === from) continue;

      const gate = this.checkOrchestrationPolicy(from, "send", agent);
      if (!gate.allowed) {
        results.push(`${agent}: denied (${gate.reason})`);
        continue;
      }

      const state = this.modeManager.getAgentState(agent);
      if (!state?.sessionActive) {
        results.push(`${agent}: skipped (not active)`);
        continue;
      }

      const envelope = `[Broadcast from ${from}]\n${message}`;
      this.workspace.runInPane(agent, envelope);
      results.push(`${agent}: delivered`);
    }

    log().info("broadcast", `${from} broadcast to ${allAgents.length - 1} agents`, { results });
    return results.join("\n");
  }

  private async handleNotification(message: string, recipients?: string[]): Promise<void> {
    const targets = recipients ?? Object.keys(this.config.agents);
    log().info("mcp", `Notification to ${targets.join(", ")}`, { messageLength: message.length });
    for (const agent of targets) {
      this.stateStore.insertMessage({
        sender: "conductor",
        recipient: agent,
        type: "notification",
        content: message,
      });
    }
  }

  private async handleHumanInputRequest(
    from: string,
    question: string,
    context: string,
    options?: string[]
  ): Promise<string> {
    const autonomy = this.modeManager.getAutonomy(from);
    log().info("escalation", `${from} requesting human input (${autonomy})`, { question: question.slice(0, 100) });

    // ── Auto mode: judge drafts and delivers, no human needed ──
    if (autonomy === "autonomous") {
      const judgment = await this.stallJudge.judge(from, `Agent asked: ${question}\nContext: ${context}`);
      if (judgment.draft) {
        log().info("escalation", `${from}: auto-responded`, { reasoning: judgment.reasoning });
        return `[Auto-response from conductor] ${judgment.draft}`;
      }
      log().warn("escalation", `${from}: auto-response failed, escalating to operator`);
      return this.escalateToOperator(from, question, context, options);
    }

    // ── Approve mode: draft a response, show operator for sign-off ──
    if (autonomy === "approve") {
      const judgment = await this.stallJudge.judge(from, `Agent asked: ${question}\nContext: ${context}`);
      const draftText = judgment.draft || "(Could not draft a response — needs your input)";

      this.stateStore.insertEscalation({
        agent: from,
        sessionId: null,
        actionType: "human_input",
        actionDetail: JSON.stringify({ question, context, options, draft: draftText }),
        agentContext: context,
      });

      const pending = this.stateStore.getPendingEscalations();
      const latest = pending[pending.length - 1];
      const id = latest?.id ?? 0;

      this.pendingApprovals.set(id, {
        agent: from,
        action: "respond_to_user",
        target: from,
        message: draftText,
      });

      const optionsText = options?.length
        ? "\n*Options:* " + options.map((o, i) => `${i + 1}. ${o}`).join(", ")
        : "";

      const text = [
        `🔒 *${from}* asks (approve mode):`,
        "",
        question,
        context ? `\n_Context: ${context}_` : "",
        optionsText,
        "",
        `*Conductor recommends:*`,
        draftText,
      ].filter(Boolean).join("\n");

      const buttons = [
        [
          { text: "✅ Send recommendation", callback_data: `approve:${id}` },
          { text: "❌ Deny", callback_data: `deny:${id}` },
        ],
        [{ text: "✏️ Custom response", callback_data: `custom:${id}` }],
      ];

      this.telegram?.send(text, buttons);

      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (!this.pendingApprovals.has(id)) {
            clearInterval(checkInterval);
            const escalation = this.stateStore.getEscalationById(id);
            if (escalation?.resolution_note) {
              resolve(escalation.resolution_note);
            } else if (escalation?.status === "denied") {
              resolve("[Request denied by operator]");
            } else {
              resolve(draftText);
            }
          }
        }, 2000);
      });
    }

    // ── Facilitated mode: send directly to operator ──
    return this.escalateToOperator(from, question, context, options);
  }

  private escalateToOperator(
    from: string,
    question: string,
    context: string,
    options?: string[]
  ): Promise<string> {
    return new Promise((resolve) => {
      const text = [`❓ *${from}* asks:`, "", question];
      if (context) text.push("", `_Context: ${context}_`);

      const buttons = options?.map((opt, i) => ({
        text: opt,
        callback_data: `human_input:${i}:${opt}`,
      }));

      this.telegram?.send(text.join("\n"), buttons ? [buttons] : undefined);

      this.stateStore.insertEscalation({
        agent: from,
        sessionId: null,
        actionType: "human_input",
        actionDetail: question,
        agentContext: context,
      });

      const checkInterval = setInterval(() => {
        const pending = this.stateStore.getPendingEscalations();
        const resolved = pending.find(
          (e) => e.action_type === "human_input" && e.status !== "pending"
        );
        if (resolved) {
          clearInterval(checkInterval);
          log().info("escalation", "Human input received", { response: resolved.resolution_note });
          resolve(resolved.resolution_note ?? "approved");
        }
      }, 2000);
    });
  }

  private formatAgentLine(name: string): string {
    const report = this.getAgentStatus(name);
    const statusIcon = report.activityStatus === "working" ? "🟢" :
                       report.activityStatus === "stalled" ? "🟡" :
                       report.activityStatus === "awaiting_approval" ? "🔵" :
                       report.activityStatus === "wrapping_up" ? "🟠" : "⚪";
    const modeMap: Record<string, string> = { autonomous: "auto", facilitated: "facil", approve: "approve" };
    const mode = modeMap[report.autonomy] ?? report.autonomy;
    const nudge = report.nudgeLevel !== "regular" ? ` [${report.nudgeLevel}]` : "";
    return `  • \`${name}\` — ${statusIcon} ${report.activityStatus} (${mode}${nudge})`;
  }

  private buildWelcomeMessage(): string {
    const allNames = Object.keys(this.config.agents);
    const pending = this.stateStore.getPendingEscalations().length;

    const cognitiveNames = allNames.filter(n => this.isCognitiveAgent(n));
    const instanceNames = allNames.filter(n => !this.isCognitiveAgent(n));

    const sections: string[] = [];
    if (cognitiveNames.length > 0) {
      sections.push("*Agents:*", ...cognitiveNames.map(n => this.formatAgentLine(n)));
    }
    if (instanceNames.length > 0) {
      if (sections.length > 0) sections.push("");
      sections.push("*Instances:*", ...instanceNames.map(n => this.formatAgentLine(n)));
    }
    if (sections.length === 0) {
      sections.push("*No agents registered.*");
    }

    return [
      "*Agent Conductor — Welcome*",
      "",
      `Escalations pending: ${pending}`,
      "",
      ...sections,
      "",
      "*Commands:*",
      "`/status` — agent overview",
      "`/start <agent|all>` — start a session",
      "`/continue <agent|all>` — resume last session",
      "`/stop <agent|all>` — stop a session",
      "`/talk <agent>` — set conversation target (`/speak` alias)",
      "`/tell <agent> <msg>` — start with directive",
      "`/<agent> <msg>` — shortcut for talk+send",
      "`/broadcast <msg>` — send message to all active agents",
      "",
      "*Modes:*",
      "`/auto <agent|all>` — autonomous mode",
      "`/approve <agent|all>` — approve mode",
      "`/facil <agent|all>` — facilitated mode",
      "`/nudge <agent|all> <low|regular|aggressive>` — nudge level",
      "",
      "*Escalations:*",
      "`/queue` — pending items",
      "`/approve <id>` — approve",
      "`/deny <id>` — deny",
      "`/clear` — dismiss all pending escalations",
      "",
      "*Debug:*",
      "`/tail <agent> [lines]` — capture agent's pane",
      "",
      "*Pass-through:*",
      "`//<cmd>` — forward slash command to talk target",
      "",
      "_Use `all` in place of agent name to target every agent._",
      "_\"yes\"/\"no\" to approve/deny when there's one pending escalation._",
    ].join("\n");
  }

  private updateStatus(): void {
    const summary = this.modeManager.getStatusSummary();
    const pending = this.stateStore.getPendingEscalations().length;
    const timeStr = new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Denver" });
    const statusText = `${summary} | ${pending} escalation(s) | ${timeStr}`;

    this.workspace.updateWindowTitle(statusText);
  }

  private allAgentNames(): string[] {
    return Object.keys(this.config.agents);
  }

  private async handleTelegramCommand(command: string, args: string): Promise<string> {
    log().info("telegram", `Command: ${command} ${args}`.trim());

    switch (command) {
      case "/help":
        return this.buildWelcomeMessage();

      case "/status":
        return this.buildWelcomeMessage();

      case "/broadcast": {
        const message = args.trim();
        if (!message) return "Usage: /broadcast <message>";
        const agents = this.allAgentNames();
        const results: string[] = [];
        for (const agent of agents) {
          const state = this.modeManager.getAgentState(agent);
          if (!state?.sessionActive) {
            results.push(`${agent}: skipped (not active)`);
            continue;
          }
          this.workspace.runInPane(agent, `[Broadcast from operator]\n${message}`);
          results.push(`${agent}: delivered`);
        }
        log().info("broadcast", `Operator broadcast to ${agents.length} agents`, { results });
        const delivered = results.filter(r => r.includes("delivered")).length;
        return `Broadcast sent to ${delivered} active agent(s).\n${results.join("\n")}`;
      }

      case "/start": {
        const agent = args.trim();
        if (!agent) return this.buildWelcomeMessage();
        if (agent === "all") {
          const agents = this.allAgentNames();
          for (const a of agents) this.startAgent(a);
          return `Starting all ${agents.length} agents...`;
        }
        if (!this.config.agents[agent]) return `Unknown agent: ${agent}`;
        this.startAgent(agent);
        return `Starting ${agent}...`;
      }

      case "/continue": {
        const agent = args.trim();
        if (agent === "all") {
          const agents = this.allAgentNames();
          for (const a of agents) this.continueAgent(a);
          return `Resuming all ${agents.length} agents...`;
        }
        if (!this.config.agents[agent]) return `Unknown agent: ${agent}`;
        this.continueAgent(agent);
        return `Resuming ${agent}'s last session...`;
      }

      case "/stop": {
        const agent = args.trim();
        if (agent === "all") {
          const agents = this.allAgentNames();
          for (const a of agents) await this.stopAgent(a);
          return `Stopped all ${agents.length} agents.`;
        }
        if (!this.config.agents[agent]) return `Unknown agent: ${agent}`;
        await this.stopAgent(agent);
        return `Stopped ${agent}.`;
      }

      case "/talk":
      case "/speak": {
        const agent = args.trim();
        if (!this.config.agents[agent]) return `Unknown agent: ${agent}`;
        this.modeManager.setTalkActive(agent, true);
        log().info("telegram", `Talk target set: ${agent}`);
        return `Now talking to ${agent}. Send messages and they'll be forwarded.`;
      }

      case "/approve": {
        const arg = args.trim();
        if (!arg) return "Usage: /approve <agent|all> or /approve <id>";
        if (arg === "all") {
          const agents = this.allAgentNames();
          for (const a of agents) this.setAutonomy(a, "approve");
          return `All ${agents.length} agents set to approve mode.`;
        }
        const id = parseInt(arg, 10);
        if (!isNaN(id)) {
          log().info("escalation", `#${id} approved via Telegram`);
          this.escalationQueue.handleResponse(id, "approved");
          return `✅ #${id} approved.`;
        }
        if (!this.config.agents[arg]) return `Unknown agent: ${arg}`;
        this.setAutonomy(arg, "approve");
        return `${arg} set to approve mode (outbound messages require approval).`;
      }

      case "/auto": {
        // /auto <agent> ["objective text"]
        // /auto <agent|all>
        const trimmed = args.trim();
        const quoteMatch = trimmed.match(/^(\S+)\s+"(.+)"$/s) || trimmed.match(/^(\S+)\s+'(.+)'$/s);
        const agent = quoteMatch ? quoteMatch[1] : trimmed;
        const objective = quoteMatch ? quoteMatch[2] : null;

        if (agent === "all") {
          const agents = this.allAgentNames();
          for (const a of agents) {
            this.setAutonomy(a, "autonomous");
            if (objective) this.modeManager.setAutoObjective(a, objective);
          }
          const objNote = objective ? ` Objective: "${objective.slice(0, 80)}"` : "";
          return `All ${agents.length} agents set to autonomous.${objNote}`;
        }
        if (!this.config.agents[agent]) return `Unknown agent: ${agent}`;
        this.setAutonomy(agent, "autonomous");
        if (objective) {
          this.modeManager.setAutoObjective(agent, objective);
          log().info("mode", `${agent}: auto with objective: ${objective.slice(0, 100)}`);
          return `${agent} set to autonomous. Objective: "${objective.slice(0, 80)}"`;
        }
        return `${agent} set to autonomous.`;
      }

      case "/facilitated":
      case "/facil": {
        const agent = args.trim();
        if (agent === "all") {
          const agents = this.allAgentNames();
          for (const a of agents) {
            this.setAutonomy(a, "facilitated");
            this.modeManager.setAutoObjective(a, null);
          }
          return `All ${agents.length} agents set to facilitated.`;
        }
        if (!this.config.agents[agent]) return `Unknown agent: ${agent}`;
        this.setAutonomy(agent, "facilitated");
        this.modeManager.setAutoObjective(agent, null);
        return `${agent} set to facilitated.`;
      }

      case "/tell": {
        const spaceIdx = args.indexOf(" ");
        if (spaceIdx === -1) return "Usage: /tell <agent> <message>";
        const agent = args.slice(0, spaceIdx).trim();
        const message = args.slice(spaceIdx + 1).trim();
        if (!this.config.agents[agent]) return `Unknown agent: ${agent}`;
        log().info("telegram", `Directive to ${agent}: ${message.slice(0, 80)}`);
        this.startAgent(agent, message);
        return `Directive sent to ${agent}.`;
      }

      case "/clear": {
        const count = this.stateStore.clearPendingEscalations();
        this.pendingApprovals.clear();
        log().info("escalation", `Queue cleared: ${count} escalations dismissed`);
        return `Cleared ${count} pending escalation(s).`;
      }

      case "/nudge": {
        const nudgeArgs = args.trim().split(/\s+/);
        const nudgeAgent = nudgeArgs[0];
        const nudgeLevel = nudgeArgs[1];
        if (!nudgeAgent || !nudgeLevel) return "Usage: /nudge <agent|all> <low|regular|aggressive>";
        if (nudgeLevel !== "low" && nudgeLevel !== "regular" && nudgeLevel !== "aggressive") {
          return "Level must be: low, regular, or aggressive";
        }
        if (nudgeAgent === "all") {
          const agents = this.allAgentNames();
          for (const a of agents) this.modeManager.setNudgeLevel(a, nudgeLevel);
          log().info("mode", `All agents nudge level → ${nudgeLevel}`);
          return `All ${agents.length} agents nudge level set to ${nudgeLevel}.`;
        }
        if (!this.config.agents[nudgeAgent]) return `Unknown agent: ${nudgeAgent}`;
        this.modeManager.setNudgeLevel(nudgeAgent, nudgeLevel);
        log().info("mode", `${nudgeAgent} nudge level → ${nudgeLevel}`);
        return `${nudgeAgent} nudge level set to ${nudgeLevel}.`;
      }

      case "/tail": {
        const argParts = args.trim().split(/\s+/);
        const agent = argParts[0];
        const linesArg = argParts[1];
        if (!agent) return "Usage: /tail <agent> [lines]";
        if (!this.config.agents[agent]) return `Unknown agent: ${agent}`;
        const lines = linesArg ? parseInt(linesArg, 10) : 30;
        if (isNaN(lines) || lines < 1 || lines > 500) {
          return "Lines must be 1-500.";
        }
        const content = this.workspace.capturePane(agent, lines);
        if (!content.trim()) {
          return `No output captured from ${agent} (tab may not exist or be empty).`;
        }
        return "```\n" + content.trimEnd() + "\n```";
      }

      case "/queue": {
        const pending = this.stateStore.getPendingEscalations();
        if (pending.length === 0) return "No pending escalations.";
        return pending.map((e) => `#${e.id} | ${e.agent} | ${e.action_type}`).join("\n");
      }

      case "/deny": {
        const id = parseInt(args.trim(), 10);
        if (isNaN(id)) return "Usage: /deny <id>";
        log().info("escalation", `#${id} denied via Telegram`);
        this.escalationQueue.handleResponse(id, "denied");
        return `❌ #${id} denied.`;
      }

      case "/_callback_approve": {
        const id = parseInt(args, 10);
        if (!isNaN(id)) {
          log().info("escalation", `#${id} approved via inline button`);
          this.escalationQueue.handleResponse(id, "approved");
        }
        return `✅ #${id} approved.`;
      }

      case "/_callback_deny": {
        const id = parseInt(args, 10);
        if (!isNaN(id)) {
          log().info("escalation", `#${id} denied via inline button`);
          this.escalationQueue.handleResponse(id, "denied");
        }
        return `❌ #${id} denied.`;
      }

      case "/_callback_custom": {
        const id = parseInt(args, 10);
        if (!isNaN(id)) {
          log().info("escalation", `#${id}: custom response requested, awaiting next message`);
          this.pendingCustomReplyId = id;
          this.telegram?.send(`Type your custom response. Your next message will be sent as the nudge for #${id}.`);
        }
        return "";
      }

      case "/_callback_context": {
        const id = parseInt(args, 10);
        log().debug("escalation", `Context requested for #${id}`);
        const pending = this.stateStore.getPendingEscalations();
        const item = pending.find((e) => e.id === id);
        if (!item) return "Not found.";
        return `Agent: ${item.agent}\nAction: ${item.action_type}\nDetail: ${item.action_detail}\nReason: ${item.agent_context ?? "none"}`;
      }

      default:
        const agentName = command.slice(1);
        if (this.config.agents[agentName]) {
          log().info("telegram", `Agent shortcut: ${agentName}`);
          this.modeManager.setTalkActive(agentName, true);
          if (args.trim()) {
            await this.handleAgentMessage(agentName, args.trim(), { forwardResponseToTelegram: true });
            return "";
          }
          return `Talking to ${agentName}.`;
        }
        log().debug("telegram", `Unknown command: ${command}`);
        return `Unknown command: ${command}. Try /status, /start, /talk, /mode, /auto, /facilitated, /tell, /queue, /approve, /deny`;
    }
  }

  private async handleAgentMessage(
    agent: string,
    text: string,
    options?: { forwardResponseToTelegram?: boolean }
  ): Promise<void> {
    log().info("message", `→ ${agent}: ${text.slice(0, 100)}`);

    // When the message is coming from operator's phone via Telegram, append
    // a protocol marker at the end. The marker activates the conductor
    // protocol (documented in the agent's knowledge/conductor-protocol.md)
    // which directs the agent to reply via the respond_to_user MCP tool.
    const fromTelegram = !!options?.forwardResponseToTelegram;
    const autonomy = this.modeManager.getAutonomy(agent);
    // Don't append CONDUCTOR_REMOTE_ACTIVE for auto/approve agents —
    // they shouldn't call respond_to_user. The conductor handles operator communication.
    const relayText = fromTelegram && autonomy === "facilitated"
      ? `${text}\n\n---\nCONDUCTOR_REMOTE_ACTIVE\nvia: mobile (Telegram)\nagent: ${agent}`
      : text;

    const state = this.modeManager.getAgentState(agent);
    if (!state?.sessionActive) {
      log().info("message", `${agent} not active — starting new session with message`);
      this.startAgent(agent, relayText);
      return;
    }

    log().info("message", `Relaying to ${agent}'s iTerm2 pane`);
    this.workspace.runInPane(agent, relayText);
  }

  private async handleFreeText(text: string): Promise<string | null> {
    // Custom reply for approve mode — next message after ✏️ button
    if (this.pendingCustomReplyId !== null) {
      const id = this.pendingCustomReplyId;
      this.pendingCustomReplyId = null;
      log().info("escalation", `#${id}: custom response from operator`);
      this.escalationQueue.handleResponse(id, "approved", text);
      return `✅ #${id} — custom response sent.`;
    }

    const talkTarget = this.modeManager.getTalkTarget();
    if (talkTarget) {
      log().info("telegram", `Free text → ${talkTarget}: ${text.slice(0, 80)}`);
      await this.handleAgentMessage(talkTarget, text, { forwardResponseToTelegram: true });
      return null;
    }

    const lower = text.toLowerCase().trim();
    if (lower === "yes" || lower === "approve") {
      const pending = this.stateStore.getPendingEscalations();
      if (pending.length === 1) {
        log().info("escalation", `Quick-approve #${pending[0].id} via "yes"`);
        this.escalationQueue.handleResponse(pending[0].id, "approved");
        return `✅ #${pending[0].id} approved.`;
      }
    }
    if (lower === "no" || lower === "deny") {
      const pending = this.stateStore.getPendingEscalations();
      if (pending.length === 1) {
        log().info("escalation", `Quick-deny #${pending[0].id} via "no"`);
        this.escalationQueue.handleResponse(pending[0].id, "denied");
        return `❌ #${pending[0].id} denied.`;
      }
    }

    log().debug("telegram", `Unrouted free text: ${text.slice(0, 80)}`);
    return "No active conversation. Use /talk <agent> or /start <agent>.";
  }
}
