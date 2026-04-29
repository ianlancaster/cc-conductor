import type { McpToolHandler } from "./server.js";
import type { AgentStatusReport } from "../supervisor.js";
import type { PanePlacement } from "../session/types.js";

export type PolicyCheck = { allowed: boolean; reason?: string };

export type McpToolDeps = {
  // Communication
  notifyAgents: (message: string, recipients?: string[]) => Promise<void>;
  broadcastToAgents: (from: string, message: string) => Promise<string>;
  requestHumanInput: (from: string, question: string, context: string, options?: string[]) => Promise<string>;
  respondToUser: (fromAgent: string, message: string) => Promise<string>;

  // Orchestration
  startAgent: (codename: string, prompt?: string, opts?: { placement?: PanePlacement }) => Promise<void>;
  stopAgent: (codename: string) => Promise<void>;
  continueAgent: (codename: string, opts?: { placement?: PanePlacement }) => Promise<void>;
  setAutonomy: (codename: string, autonomy: "autonomous" | "facilitated" | "approve") => void;
  sendToAgent: (codename: string, message: string) => Promise<void>;
  typeInPane: (codename: string, text: string) => void;

  // Context management
  requestContext: (agentCodename: string) => Promise<string>;
  requestRestart: (agentCodename: string, reason: string) => Promise<string>;

  // Observability
  listAgents: () => AgentStatusReport[];
  getAgentStatus: (codename: string) => AgentStatusReport;
  capturePane: (agent: string, lines?: number) => string;

  // Mode control
  setNudgeLevel: (codename: string, level: "low" | "regular" | "aggressive") => void;
  setTag: (codename: string, tag: string | null) => void;
  getTag: (codename: string) => string | null;
  listEscalations: () => Array<{
    id: number;
    agent: string;
    actionType: string;
    actionDetail: string | null;
    createdAt: string;
  }>;

  // Policy
  checkOrchestrationPolicy: (
    sender: string,
    verb: "start" | "stop" | "continue" | "setAutonomy" | "send",
    target: string
  ) => PolicyCheck;

  // Lifecycle
  spawnAgent: (codename: string, opts?: { path?: string; model?: string; prompt?: string; placement?: PanePlacement }) => Promise<string>;
  teardownAgent: (codename: string, deleteDir?: boolean) => Promise<string>;

  // Registry — used to validate agent codenames in tool calls
  agentExists: (codename: string) => boolean;
};

const requireArg = (value: unknown, name: string): string | null => {
  if (typeof value !== "string" || value.length === 0) {
    return `Error: '${name}' is required and must be a non-empty string.`;
  }
  return null;
};

export function buildMcpTools(deps: McpToolDeps): Record<
  string,
  { description: string; inputSchema: Record<string, unknown>; handler: McpToolHandler }
> {
  return {
    // ── Communication ─────────────────────────────────────────────────────

    notify_agents: {
      description:
        "Queue a notification for agents. Cognitive agents receive these at their next session start; other agents see them when they next check in.",
      inputSchema: {
        message: { type: "string", description: "The notification content" },
        recipients: {
          type: "array",
          items: { type: "string" },
          description: "Agent codenames. Omit to auto-route.",
        },
      },
      handler: async (args, _caller) => {
        const message = args.message as string;
        const recipients = args.recipients as string[] | undefined;
        const err = requireArg(message, "message");
        if (err) return err;
        await deps.notifyAgents(message, recipients);
        return "Notification queued.";
      },
    },

    broadcast: {
      description:
        "Broadcast a message to all active agents' panes immediately. Fire-and-forget — delivered to every active peer (excluding yourself). Agents that are not active are skipped. Policy-checked per target. Your identity is determined automatically by the conductor.",
      inputSchema: {
        message: {
          type: "string",
          description: "Message content to broadcast",
        },
      },
      handler: async (args, caller) => {
        const message = args.message as string;
        const err = requireArg(message, "message");
        if (err) return err;
        return deps.broadcastToAgents(caller, message);
      },
    },

    respond_to_user: {
      description:
        "Send your final response to the operator. Use this exactly once when you're ready to reply. The message is delivered immediately via the operator's active channel (Telegram when messaging from mobile, terminal otherwise). Keep the response concise and mobile-friendly — plain prose, no code fences, no tables. Your identity is determined automatically by the conductor.",
      inputSchema: {
        message: {
          type: "string",
          description: "Your response text to deliver to the user",
        },
      },
      handler: async (args, caller) => {
        const message = args.message as string;
        const err = requireArg(message, "message");
        if (err) return err;
        return deps.respondToUser(caller, message);
      },
    },

    request_human_input: {
      description:
        "Ask for a decision on something that needs human judgment. In facilitated mode, this goes directly to the operator. In approve/auto mode, the conductor drafts a response using its local model — approve mode shows the operator the draft for sign-off, auto mode delivers it directly. Your identity is determined automatically by the conductor.",
      inputSchema: {
        question: { type: "string", description: "The question or decision needed" },
        context: { type: "string", description: "Background context to help decide" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional multiple-choice options",
        },
      },
      handler: async (args, caller) => {
        const question = args.question as string;
        const context = (args.context as string) ?? "";
        const options = args.options as string[] | undefined;
        const err = requireArg(question, "question");
        if (err) return err;
        return deps.requestHumanInput(caller, question, context, options);
      },
    },

    // ── Orchestration (policy-gated) ──────────────────────────────────────

    start_agent: {
      description:
        "Start a session for another agent. If 'prompt' is provided, it is sent as the initial directive (equivalent to Telegram's /tell). Blocked if policy denies. Cannot target self. Your identity is determined automatically by the conductor.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename to start" },
        prompt: { type: "string", description: "Optional initial directive" },
        placement: { type: "string", enum: ["pane", "tab", "window"], description: "Where to open the session (default: pane)" },
      },
      handler: async (args, caller) => {
        const codename = args.codename as string;
        const prompt = args.prompt as string | undefined;
        const placement = args.placement as PanePlacement | undefined;
        const err = requireArg(codename, "codename");
        if (err) return err;
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        const gate = deps.checkOrchestrationPolicy(caller, "start", codename);
        if (!gate.allowed) return `Error: ${gate.reason}`;
        await deps.startAgent(codename, prompt, { placement });
        return `Started ${codename}.`;
      },
    },

    stop_agent: {
      description:
        "Stop another agent's active session cleanly. No-op if the agent has no active session. Blocked if policy denies. Cannot target self. Your identity is determined automatically by the conductor.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename to stop" },
      },
      handler: async (args, caller) => {
        const codename = args.codename as string;
        const err = requireArg(codename, "codename");
        if (err) return err;
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        const gate = deps.checkOrchestrationPolicy(caller, "stop", codename);
        if (!gate.allowed) return `Error: ${gate.reason}`;
        await deps.stopAgent(codename);
        return `Stopped ${codename}.`;
      },
    },

    continue_agent: {
      description:
        "Resume another agent's most recent session (equivalent to Telegram's /continue). Blocked if policy denies. Your identity is determined automatically by the conductor.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename to continue" },
        placement: { type: "string", enum: ["pane", "tab", "window"], description: "Where to open the session (default: pane)" },
      },
      handler: async (args, caller) => {
        const codename = args.codename as string;
        const placement = args.placement as PanePlacement | undefined;
        const err = requireArg(codename, "codename");
        if (err) return err;
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        const gate = deps.checkOrchestrationPolicy(caller, "continue", codename);
        if (!gate.allowed) return `Error: ${gate.reason}`;
        await deps.continueAgent(codename, { placement });
        return `Resuming ${codename}.`;
      },
    },

    set_autonomy: {
      description:
        "Set another agent's autonomy mode. 'autonomous' means the agent runs without per-turn human facilitation; 'facilitated' waits for turn-by-turn input. Your identity is determined automatically by the conductor.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename" },
        mode: {
          type: "string",
          description: "Autonomy mode",
          enum: ["autonomous", "facilitated"],
        },
      },
      handler: async (args, caller) => {
        const codename = args.codename as string;
        const mode = args.mode as "autonomous" | "facilitated" | "approve";
        const err =
          requireArg(codename, "codename") ||
          requireArg(mode, "mode");
        if (err) return err;
        if (mode !== "autonomous" && mode !== "facilitated" && mode !== "approve") {
          return "Error: mode must be 'autonomous', 'facilitated', or 'approve'";
        }
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        const gate = deps.checkOrchestrationPolicy(caller, "setAutonomy", codename);
        if (!gate.allowed) return `Error: ${gate.reason}`;
        deps.setAutonomy(codename, mode);
        return `${codename} set to ${mode}.`;
      },
    },

    send_to_agent: {
      description:
        "Send a message to another agent's active session. Fire-and-forget — no response is returned. If the target has no active session, a new session is started with the message as the initial prompt. Your identity is determined automatically by the conductor and included in the message envelope.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename to send to" },
        message: { type: "string", description: "Message content" },
      },
      handler: async (args, caller) => {
        const codename = args.codename as string;
        const message = args.message as string;
        const err =
          requireArg(codename, "codename") ||
          requireArg(message, "message");
        if (err) return err;
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        const gate = deps.checkOrchestrationPolicy(caller, "send", codename);
        if (!gate.allowed) return `Error: ${gate.reason}`;
        const envelope = `[Message from ${caller}]\n${message}`;
        await deps.sendToAgent(codename, envelope);
        return `Message sent to ${codename}.`;
      },
    },

    // ── Lifecycle ──────────────────────────────────────────────────────

    spawn_agent: {
      description:
        "Create and start a new Claude Code instance. Creates directory if needed, writes config, registers, and starts a session. Use for ephemeral work, testing, or on-demand instances.",
      inputSchema: {
        codename: { type: "string", description: "Codename for the new agent" },
        path: { type: "string", description: "Directory path (optional — defaults to sibling of conductor)" },
        model: { type: "string", description: "Claude model (optional — defaults to claude-sonnet-4-6)" },
        prompt: { type: "string", description: "Initial prompt to send after starting (optional)" },
        placement: { type: "string", enum: ["pane", "tab", "window"], description: "Where to open the session (default: pane)" },
      },
      handler: async (args, _caller) => {
        const codename = args.codename as string;
        const err = requireArg(codename, "codename");
        if (err) return err;
        return deps.spawnAgent(codename, {
          path: args.path as string | undefined,
          model: args.model as string | undefined,
          prompt: args.prompt as string | undefined,
          placement: args.placement as PanePlacement | undefined,
        });
      },
    },

    teardown_agent: {
      description:
        "Stop, deregister, and optionally delete a spawned agent. Refuses to delete directories with .git or .cognitive-agent markers.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename to tear down" },
        deleteDir: { type: "boolean", description: "Also delete the agent's directory (default false)" },
      },
      handler: async (args, _caller) => {
        const codename = args.codename as string;
        const err = requireArg(codename, "codename");
        if (err) return err;
        return deps.teardownAgent(codename, args.deleteDir === true);
      },
    },

    // ── Context management ─────────────────────────────────────────────

    request_context: {
      description:
        "Get your current context token usage. The conductor types /context into your pane and returns the parsed result (e.g., '392K / 1M (39%)'). Your identity is determined automatically by the conductor.",
      inputSchema: {},
      handler: async (_args, caller) => {
        return deps.requestContext(caller);
      },
    },

    request_restart: {
      description:
        "Request a full session teardown and fresh start. Cognitive agents run their sleep/wake rituals; generic instances get a clean restart. Use when context is above 650K, compaction wasn't enough, or work has shifted significantly. Save your work first. Your identity is determined automatically by the conductor.",
      inputSchema: {
        reason: { type: "string", description: "Why you need a restart (logged for diagnostics)" },
      },
      handler: async (args, caller) => {
        const reason = args.reason as string;
        const err = requireArg(reason, "reason");
        if (err) return err;
        return deps.requestRestart(caller, reason);
      },
    },

    // ── Observability (ungated) ───────────────────────────────────────────

    list_agents: {
      description:
        "List all registered agents with current status (autonomy, transport, active session, stall count, pending escalations).",
      inputSchema: {},
      handler: async (_args, _caller) => {
        const agents = deps.listAgents();
        return JSON.stringify(agents, null, 2);
      },
    },

    get_agent_status: {
      description: "Get detailed status for a single agent by codename.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename" },
      },
      handler: async (args, _caller) => {
        const codename = args.codename as string;
        const err = requireArg(codename, "codename");
        if (err) return err;
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        return JSON.stringify(deps.getAgentStatus(codename), null, 2);
      },
    },

    list_escalations: {
      description:
        "List pending escalations across the network. Observability only — resolving escalations remains human-gated (no approve/deny tool is exposed to agents).",
      inputSchema: {},
      handler: async (_args, _caller) => {
        return JSON.stringify(deps.listEscalations(), null, 2);
      },
    },

    tail_agent: {
      description:
        "Read the trailing output from another agent's terminal pane. Returns the last N lines (default 30, max 500). Use this to observe what an agent is doing, read its questions, or monitor progress.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename to read from" },
        lines: { type: "number", description: "Number of trailing lines to capture (default 30, max 500)" },
      },
      handler: async (args, _caller) => {
        const codename = args.codename as string;
        const lines = (args.lines as number) ?? 30;
        const err = requireArg(codename, "codename");
        if (err) return err;
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        if (lines < 1 || lines > 500) return "Error: lines must be 1-500.";
        const content = deps.capturePane(codename, lines);
        if (!content.trim()) {
          return `No output captured from ${codename} (pane may not exist or be empty).`;
        }
        return content;
      },
    },

    set_nudge_level: {
      description:
        "Set an agent's nudge level, which controls how aggressively the conductor prompts idle agents. 'low' = longer stall tolerance, 'regular' = default, 'aggressive' = shorter tolerance.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename to configure" },
        level: {
          type: "string",
          description: "Nudge level",
          enum: ["low", "regular", "aggressive"],
        },
      },
      handler: async (args, _caller) => {
        const codename = args.codename as string;
        const level = args.level as "low" | "regular" | "aggressive";
        const err =
          requireArg(codename, "codename") ||
          requireArg(level, "level");
        if (err) return err;
        if (level !== "low" && level !== "regular" && level !== "aggressive") {
          return "Error: level must be 'low', 'regular', or 'aggressive'";
        }
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        deps.setNudgeLevel(codename, level);
        return `${codename} nudge level set to ${level}.`;
      },
    },

    set_tag: {
      description:
        "Set or clear an arbitrary label on an agent. The tag shows up in status displays and the iTerm2 pane/tab header next to the codename. Pass null or empty string to clear.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename to tag" },
        tag: { type: "string", description: "Label text (omit or empty to clear)" },
      },
      handler: async (args, _caller) => {
        const codename = args.codename as string;
        const tag = (args.tag as string | undefined)?.trim() || null;
        const err = requireArg(codename, "codename");
        if (err) return err;
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        deps.setTag(codename, tag);
        return tag ? `${codename} tagged: "${tag}"` : `${codename} tag cleared.`;
      },
    },

    type_in_pane: {
      description:
        "Type raw text into another agent's terminal pane with no envelope or formatting. Use this for answering numbered prompts (1/2/3), typing slash commands, or any situation where the [Message from] envelope would corrupt the input. For normal messages, use send_to_agent instead. Your identity is determined automatically by the conductor for policy checks.",
      inputSchema: {
        codename: { type: "string", description: "Agent codename to type into" },
        text: { type: "string", description: "Raw text to type — sent exactly as-is with no wrapping" },
      },
      handler: async (args, caller) => {
        const codename = args.codename as string;
        const text = args.text as string;
        const err =
          requireArg(codename, "codename") ||
          requireArg(text, "text");
        if (err) return err;
        if (!deps.agentExists(codename)) return `Error: unknown agent '${codename}'`;
        const gate = deps.checkOrchestrationPolicy(caller, "send", codename);
        if (!gate.allowed) return `Error: ${gate.reason}`;
        deps.typeInPane(codename, text);
        return `Typed into ${codename}'s pane.`;
      },
    },
  };
}
