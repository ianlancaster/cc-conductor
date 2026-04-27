import type { IterminalWorkspace } from "../transport/iterm.js";
import type { AgentPolicy } from "../config.js";
import type { StateStore } from "../engine/state-store.js";
import { log } from "../logger.js";
import { randomUUID } from "crypto";

export type AgentSessionOptions = {
  workspace: IterminalWorkspace;
  policy: AgentPolicy;
  stateStore: StateStore;
  mcpConfigPath: string;
  systemPromptPath: string;
  cognitivePromptPath?: string;
  cognitive?: boolean;
};

export class AgentSession {
  private workspace: IterminalWorkspace;
  private policy: AgentPolicy;
  private stateStore: StateStore;
  private mcpConfigPath: string;
  private systemPromptPath: string;
  private sessionId: string;
  private cognitive: boolean;
  private cognitivePromptPath: string | undefined;

  constructor(options: AgentSessionOptions) {
    this.workspace = options.workspace;
    this.policy = options.policy;
    this.stateStore = options.stateStore;
    this.mcpConfigPath = options.mcpConfigPath;
    this.systemPromptPath = options.systemPromptPath;
    this.cognitivePromptPath = options.cognitivePromptPath;
    this.sessionId = randomUUID();
    this.cognitive = options.cognitive ?? false;
  }

  continue(): string {
    log().info("session", `${this.policy.codename}: continuing previous session`, {
      repo: this.policy.repo, sessionId: this.sessionId.slice(0, 8),
    });

    const freshPane = !this.workspace.hasAgent(this.policy.codename);
    if (freshPane) {
      log().debug("session", `${this.policy.codename}: creating pane`);
      this.workspace.createAgentPane(this.policy.codename);
    }

    this.stateStore.insertSession({
      id: this.sessionId,
      agent: this.policy.codename,
      status: "active",
      promptSummary: "continue (resumed)",
    });

    const cmd = this.buildClaudeCommand({ continueSession: true });
    if (freshPane) {
      this.workspace.launchInPane(this.policy.codename, cmd);
    } else {
      this.workspace.runInPane(this.policy.codename, cmd);
    }
    return this.sessionId;
  }

  start(prompt?: string): string {
    log().info("session", `${this.policy.codename}: starting new session`, {
      repo: this.policy.repo, sessionId: this.sessionId.slice(0, 8),
      hasPrompt: !!prompt,
    });

    const freshPane = !this.workspace.hasAgent(this.policy.codename);
    if (freshPane) {
      log().debug("session", `${this.policy.codename}: creating pane`);
      this.workspace.createAgentPane(this.policy.codename);
    }

    this.stateStore.insertSession({
      id: this.sessionId,
      agent: this.policy.codename,
      status: "active",
      promptSummary: (prompt ?? "interactive").slice(0, 200),
    });

    const cmd = this.buildClaudeCommand({ continueSession: false, prompt });
    if (freshPane) {
      this.workspace.launchInPane(this.policy.codename, cmd);
    } else {
      this.workspace.runInPane(this.policy.codename, cmd);
    }
    return this.sessionId;
  }

  captureOutput(lines: number = 20): string {
    return this.workspace.capturePane(this.policy.codename, lines);
  }

  isAlive(): boolean {
    return this.workspace.isPaneAlive(this.policy.codename);
  }

  stop(): void {
    log().info("session", `${this.policy.codename}: stopping session`);
    this.workspace.killAgentPane(this.policy.codename);
    this.stateStore.updateSession(this.sessionId, { status: "completed" });
  }

  kill(): void {
    log().warn("session", `${this.policy.codename}: killing session`);
    this.workspace.killAgentPane(this.policy.codename);
    this.stateStore.updateSession(this.sessionId, { status: "failed" });
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getAgent(): string {
    return this.policy.codename;
  }

  /**
   * Build the command the shell runs when a new agent pane opens.
   *
   * Includes iTerm2 OSC 1337 escapes for SetBadgeFormat, SetUserVar
   * (conductor_agent marker, used for restart rediscovery), and
   * SetMark (so the session title can show the agent's codename
   * persistently). These are emitted via printf so they flow through
   * the shell's STDOUT stream — which is what iTerm2 interprets.
   *
   * Everything is joined with `&&` so this is ONE shell command line,
   * submitted atomically. That avoids the race condition where multiple
   * separate write-text calls stack up before the shell is ready to
   * read them and get interleaved as garbage at the prompt.
   */
  private buildClaudeCommand(opts: { continueSession: boolean; prompt?: string }): string {
    const additionalDirs = (this.policy.additionalDirs ?? [])
      .map((d) => `--add-dir ${this.shellEscape(d)}`)
      .join(" ");

    const codename = this.policy.codename;
    const codenameB64 = Buffer.from(codename, "utf-8").toString("base64");

    const oscSetup = [
      `printf '\\033]1337;SetBadgeFormat=${codenameB64}\\a'`,
      `printf '\\033]1337;SetUserVar=conductor_agent=${codenameB64}\\a'`,
      // Set the session's window/tab title to the codename. Shell prompts
      // often overwrite this later, but the user variable + badge persist.
      `printf '\\033]0;${codename}\\a'`,
    ].join(" && ");

    const claudeBin = opts.continueSession ? "claude -c" : "claude";
    const promptFiles = [
      `--append-system-prompt-file ${this.shellEscape(this.systemPromptPath)}`,
    ];
    if (this.cognitive && this.cognitivePromptPath) {
      promptFiles.push(`--append-system-prompt-file ${this.shellEscape(this.cognitivePromptPath)}`);
    }
    const claudeArgs = [
      "--dangerously-skip-permissions",
      additionalDirs,
      `--mcp-config ${this.shellEscape(this.mcpConfigPath)}`,
      ...promptFiles,
    ]
      .filter(Boolean)
      .join(" ");

    const cdCmd = `cd ${this.shellEscape(this.policy.repo)}`;
    const envVars = [
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70",
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
      "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1",
      "CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1",
      "CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      "CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0",
    ];
    const envSetup = `export ${envVars.join(" ")}`;

    if (opts.prompt && !opts.continueSession) {
      return `${oscSetup} && ${cdCmd} && ${envSetup} && echo ${this.shellEscape(opts.prompt)} | ${claudeBin} ${claudeArgs}`;
    }
    return `${oscSetup} && ${cdCmd} && ${envSetup} && ${claudeBin} ${claudeArgs}`;
  }

  private shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }
}
