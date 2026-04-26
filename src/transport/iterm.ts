import { execSync } from "child_process";
import { writeFileSync, mkdtempSync, readFileSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { log } from "../logger.js";

export type IterminalConfig = {
  windowName: string;
  // Path to a JSON file used to persist the iTerm2 window id across conductor
  // restarts. Without this, every `make start` would orphan the previous
  // window and create a fresh one.
  statePath: string;
  // Number of trailing lines to return from capturePane when no explicit count
  // is provided.
  defaultTailLines?: number;
};

export type PaneInfo = {
  agent: string;
  sessionId: string; // iTerm2 session UUID — stable identifier
};

/**
 * IterminalWorkspace drives iTerm2 via AppleScript to provide a one-window,
 * one-pane-per-agent desktop substrate for the conductor.
 *
 * Key design:
 *  - Tracks agents by iTerm2 session UUID, which is stable across the session's
 *    lifetime.
 *  - Agents are panes (not tabs) inside one tab of the conductor window. Each
 *    new agent pane is created by splitting the primary (orientation) session
 *    vertically, producing a flat side-by-side layout.
 *  - Multi-line messages to an agent use bracketed paste markers so embedded
 *    newlines are treated as content, not submit keystrokes.
 *  - Visual identity (badge, user-var marker, tab/session name) is set via
 *    iTerm2 OSC 1337 escape sequences emitted from the SHELL (via printf)
 *    inside the launch command — NOT via AppleScript write-text, because
 *    write-text puts bytes on the session's stdin, where they are swallowed
 *    by zsh's line editor rather than interpreted as terminal escapes.
 *  - The conductor window is identified by storing its iTerm2 window id on
 *    first create; on reconnect, if the stored id's window is gone, a new
 *    one is created. Existing agent panes are rediscovered via their
 *    user.conductor_agent variable.
 */
export class IterminalWorkspace {
  private windowName: string;
  private windowId: number | null = null;
  private statePath: string;
  private agentPanes = new Map<string, PaneInfo>();
  private systemPaneId: string | null = null;
  private tmpDir: string;

  constructor(config: IterminalConfig) {
    this.windowName = config.windowName;
    this.statePath = config.statePath;
    this.tmpDir = mkdtempSync(join(tmpdir(), "conductor-iterm-"));
    this.loadPersistedState();
  }

  /** Get the current window id (for diagnostics / focus commands). */
  getWindowId(): number | null {
    return this.windowId;
  }

  // ── Workspace lifecycle ─────────────────────────────────────────────

  isWorkspaceAlive(): boolean {
    if (this.windowId === null) return false;
    try {
      const result = this.runOsa(
        `tell application "iTerm2" to return (exists window id ${this.windowId}) as string`
      );
      return result.trim() === "true";
    } catch {
      return false;
    }
  }

  createWorkspace(opts?: { inline?: boolean }): void {
    if (this.isWorkspaceAlive()) {
      log().info("iterm", `Existing conductor window found (id=${this.windowId}) — rediscovering tabs`);
      this.cleanupAndRediscover();
      this.focusWindow();
      return;
    }

    // Inline mode: the conductor is already running inside an iTerm pane.
    // Detect the current window and use it instead of creating a new one.
    if (opts?.inline) {
      log().info("iterm", "Inline mode: detecting current iTerm2 window");
      try {
        const stdout = this.runOsa(`
          tell application "iTerm2"
            return id of current window as string
          end tell
        `);
        this.windowId = parseInt(stdout.trim(), 10);
        this.persistState();
        log().info("iterm", `Using current window: id=${this.windowId}`);
        return;
      } catch (err) {
        log().warn("iterm", `Inline detection failed, falling back to new window: ${String(err)}`);
      }
    }

    log().info("iterm", `Creating iTerm2 window: "${this.windowName}"`);
    const stdout = this.runOsa(`
      tell application "iTerm2"
        activate
        set newWin to (create window with default profile)
        tell current session of current tab of newWin
          set name to "${this.escapeApple(this.windowName)}"
        end tell
        return id of newWin as string
      end tell
    `);

    this.windowId = parseInt(stdout.trim(), 10);
    this.persistState();
    log().info("iterm", `Window created: id=${this.windowId}`);
  }

  /** Bring the conductor window to the foreground. */
  focusWindow(): void {
    if (this.windowId === null) return;
    try {
      this.runOsa(`
        tell application "iTerm2"
          activate
          try
            select window id ${this.windowId}
          end try
        end tell
      `);
    } catch (err) {
      log().debug("iterm", `Focus failed: ${String(err)}`);
    }
  }

  destroyWorkspace(): void {
    if (this.windowId === null) return;
    log().info("iterm", "Destroying workspace");
    try {
      this.runOsa(`
        tell application "iTerm2"
          try
            close (window id ${this.windowId})
          end try
        end tell
      `);
    } catch (err) {
      log().warn("iterm", `Destroy failed: ${String(err)}`);
    }
    this.clearPersistedState();
    this.agentPanes.clear();
    this.windowId = null;
  }

  updateWindowTitle(text: string): void {
    if (this.windowId === null) return;
    // Set the first tab's session name. iTerm2 derives window title from
    // the current session's name. We target "first tab" rather than by
    // session id because the first tab is our stable "orientation" tab.
    try {
      this.runOsa(`
        tell application "iTerm2"
          tell current session of first tab of window id ${this.windowId}
            set name to "${this.escapeApple(`${this.windowName} — ${text}`)}"
          end tell
        end tell
      `);
    } catch (err) {
      log().debug("iterm", `Update window title failed: ${String(err)}`);
    }
  }

  // ── Agent tab operations ────────────────────────────────────────────

  /**
   * Create a new tab in the conductor window for the agent. Returns the
   * iTerm2 session UUID, which should be stored and used for subsequent
   * operations instead of the agent name.
   */
  createAgentPane(agent: string, options?: { focus?: boolean }): string {
    if (this.windowId === null) {
      throw new Error("Workspace not created; call createWorkspace() first");
    }
    if (this.agentPanes.has(agent)) {
      log().debug("iterm", `${agent}: pane already exists, reusing`);
      return this.agentPanes.get(agent)!.sessionId;
    }

    const focus = options?.focus ?? true;
    log().info("iterm", `${agent}: creating pane`);

    // Create the pane by splitting the first (orientation) session of the
    // first tab. This keeps every agent pane as a sibling of the orientation
    // pane in a flat layout. Nothing is written to the session here — the
    // shell is still booting, so any bytes written now would go onto its
    // stdin buffer and be mis-executed. Visual identity (badge, user-var,
    // session name) is set later inside the claude launch command that the
    // shell itself executes.
    const stdout = this.runOsa(`
      tell application "iTerm2"
        ${focus ? "activate" : ""}
        tell window id ${this.windowId}
          tell current session of first tab
            set newSession to (split vertically with default profile)
            tell newSession
              set name to "${this.escapeApple(agent)}"
              return id as string
            end tell
          end tell
        end tell
      end tell
    `);

    const sessionId = stdout.trim();
    this.agentPanes.set(agent, { agent, sessionId });
    this.persistState();
    log().debug("iterm", `${agent}: pane created (session=${sessionId.slice(0, 8)})`);
    return sessionId;
  }

  /**
   * Submit an initial launch command to a freshly-created pane. Polls the
   * session contents for the shell prompt marker (" ==> ") before
   * submitting, so the Enter keypress lands on a live prompt rather than
   * being consumed by shell rc-file init (nvm, oh-my-zsh, plugin loaders).
   *
   * The polling happens inside a single AppleScript block via `repeat`
   * with short delays. That means this call blocks node's event loop for
   * up to the timeout — acceptable for one-time launch; other commands
   * use runInPane which has no polling.
   *
   * If the timeout fires before the prompt appears (user has an unusual
   * PS1, or zsh is genuinely hung), the command is submitted anyway on
   * best-effort — same outcome as before, no worse.
   */
  launchInPane(agent: string, command: string, timeoutSeconds: number = 8.0): void {
    const pane = this.agentPanes.get(agent);
    if (!pane) {
      log().warn("iterm", `${agent}: no pane found, cannot launch command`);
      return;
    }
    log().debug("iterm", `${agent}: launching (will poll for prompt, timeout=${timeoutSeconds}s)`);
    const path = this.writeTempContent(command);
    // Prompt markers we know about. First matches common zsh prompts
    // (" ==> "), others cover common PS1 shapes.
    const pollIters = Math.ceil(timeoutSeconds / 0.25);
    const stdout = this.inSession(
      pane.sessionId,
      `set foundPrompt to false
       repeat ${pollIters} times
         set c to (contents as string)
         if (c contains " ==> ") or (c contains "$ ") or (c contains "% ") then
           set foundPrompt to true
           exit repeat
         end if
         delay 0.25
       end repeat
       set cmdText to (read POSIX file "${path}" as «class utf8»)
       write text (cmdText & (ASCII character 13))`,
      `foundPrompt as string`
    );
    log().debug("iterm", `${agent}: launch — prompt detected=${stdout.trim()}`);
  }

  /**
   * Send a command to the agent's pane as if typed by a user.
   * Handles both single-line (submits directly) and multi-line (bracketed
   * paste then separate Enter). Use launchInPane() instead for the FIRST
   * command delivered to a brand-new pane — that has a shell-init race
   * which needs a delay.
   */
  runInPane(agent: string, command: string): void {
    const pane = this.agentPanes.get(agent);
    if (!pane) {
      log().warn("iterm", `${agent}: no pane found, cannot run command`);
      return;
    }

    const hasNewlines = command.includes("\n");
    log().debug("iterm", `${agent}: sending → ${command.slice(0, 80)}`, {
      lines: command.split("\n").length,
      method: hasNewlines ? "bracketed-paste" : "write-text",
    });

    if (hasNewlines) {
      this.writeBracketedPaste(pane.sessionId, command);
    } else {
      this.writeTextLine(pane.sessionId, command);
    }
  }

  /**
   * Return the trailing N lines of the agent's session contents.
   */
  capturePane(agent: string, lines: number = 30): string {
    const tab = this.agentPanes.get(agent);
    if (!tab) return "";
    try {
      const full = this.inSession(tab.sessionId, "", "(contents as string)");
      const allLines = full.split("\n");
      const start = Math.max(0, allLines.length - lines - 1);
      return allLines.slice(start).join("\n");
    } catch (err) {
      log().warn("iterm", `${agent}: capture failed: ${String(err)}`);
      return "";
    }
  }

  getRediscoveredAgents(): string[] {
    return Array.from(this.agentPanes.keys());
  }

  isPaneAlive(agent: string): boolean {
    const pane = this.agentPanes.get(agent);
    if (!pane) return false;
    try {
      const result = this.inSession(pane.sessionId, "", '"ALIVE"').trim();
      const alive = result === "ALIVE";
      log().debug("iterm", `${agent}: liveness check`, { alive, sessionId: pane.sessionId.slice(0, 8) });
      if (!alive) {
        this.agentPanes.delete(agent);
        this.persistState();
      }
      return alive;
    } catch {
      log().info("iterm", `${agent}: pane gone (error), clearing mapping`);
      this.agentPanes.delete(agent);
      this.persistState();
      return false;
    }
  }

  killAgentPane(agent: string): void {
    const pane = this.agentPanes.get(agent);
    if (!pane) return;
    log().info("iterm", `${agent}: closing pane`);
    try {
      // Close just the matching session (pane), not the tab it's in —
      // other agent panes may still be in the same tab.
      this.runOsa(`
        tell application "iTerm2"
          tell window id ${this.windowId}
            repeat with t in tabs
              repeat with s in sessions of t
                if (id of s) is "${pane.sessionId}" then
                  close s
                  return "OK"
                end if
              end repeat
            end repeat
          end tell
        end tell
      `);
    } catch (err) {
      log().warn("iterm", `${agent}: close failed: ${String(err)}`);
    }
    this.agentPanes.delete(agent);
    this.persistState();
  }

  hasAgent(agent: string): boolean {
    return this.agentPanes.has(agent);
  }

  getActiveAgents(): string[] {
    return Array.from(this.agentPanes.keys());
  }

  // ── System pane (usage monitoring) ──────────────────────────────────

  createSystemPane(): void {
    if (this.windowId === null) return;
    if (this.systemPaneId) {
      // Verify it still exists
      try {
        const result = this.inSession(this.systemPaneId, "", '"ALIVE"').trim();
        if (result === "ALIVE") {
          log().info("iterm", `System pane reused (session=${this.systemPaneId.slice(0, 8)})`);
          return;
        }
      } catch { /* pane gone, recreate */ }
      this.systemPaneId = null;
    }

    log().info("iterm", "Creating system pane for usage monitoring");
    const stdout = this.runOsa(`
      tell application "iTerm2"
        tell window id ${this.windowId}
          tell current session of first tab
            set newSession to (split vertically with default profile)
            tell newSession
              set name to "_system"
              return id as string
            end tell
          end tell
        end tell
      end tell
    `);
    this.systemPaneId = stdout.trim();

    // Wait for shell init, then launch claude interactively
    setTimeout(() => {
      if (!this.systemPaneId) return;
      this.writeTextLine(this.systemPaneId, "claude --dangerously-skip-permissions");
    }, 3000);

    this.persistState();
    log().info("iterm", `System pane created (session=${this.systemPaneId.slice(0, 8)})`);
  }

  checkUsage(): { session: number; weekly: number; sessionReset: string; weeklyReset: string } | null {
    if (!this.systemPaneId) return null;

    // Close any existing /usage display, then open a fresh one and leave it visible
    try {
      this.inSession(this.systemPaneId, `
        write text (ASCII character 27) without newline
        delay 0.5
        write text "/usage" & (ASCII character 13)
        delay 2
      `);
    } catch {
      // ignore
    }

    // Capture the pane
    const captured = this.captureSystemPane(40);

    // Parse session %
    const sessionMatch = captured.match(/Current session.*?\n.*?(\d+)%\s*used/s);
    const weeklyMatch = captured.match(/Current week \(all models\).*?\n.*?(\d+)%\s*used/s);
    const sessionResetMatch = captured.match(/Current session.*?Resets\s+(.+?)\s+(\d+)%/s);
    const weeklyResetMatch = captured.match(/Current week \(all models\).*?Resets\s+(.+?)\s+(\d+)%/s);

    if (!sessionMatch && !weeklyMatch) {
      log().debug("iterm", "Usage parse failed", { captured: captured.slice(-200) });
      return null;
    }

    return {
      session: sessionMatch ? parseInt(sessionMatch[1], 10) : 0,
      weekly: weeklyMatch ? parseInt(weeklyMatch[1], 10) : 0,
      sessionReset: sessionResetMatch?.[1]?.trim() ?? "unknown",
      weeklyReset: weeklyResetMatch?.[1]?.trim() ?? "unknown",
    };
  }

  private captureSystemPane(lines: number): string {
    if (!this.systemPaneId) return "";
    try {
      const full = this.inSession(this.systemPaneId, "", "(contents as string)");
      const allLines = full.split("\n");
      const start = Math.max(0, allLines.length - lines - 1);
      return allLines.slice(start).join("\n");
    } catch {
      return "";
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  private writeTextLine(sessionId: string, text: string): void {
    const path = this.writeTempContent(text);
    // Write text first, then send CR separately after a brief delay.
    // CR (ASCII 13) is what terminals expect for Enter/submit.
    // iTerm2's default `newline true` appends LF which does NOT
    // trigger readline's accept-line.
    this.inSession(sessionId,
      `set cmdText to (read POSIX file "${path}" as «class utf8»)
       write text cmdText without newline
       delay 0.2
       write text (ASCII character 13)`);
  }

  private writeBracketedPaste(sessionId: string, text: string): void {
    const ESC = String.fromCharCode(27);
    const wrapped = `${ESC}[200~${text}${ESC}[201~`;
    const path = this.writeTempContent(wrapped);
    this.inSession(
      sessionId,
      `write contents of file "${path}" newline false
       delay 0.1
       write text (ASCII character 13)`
    );
  }

  /**
   * Execute AppleScript operations inside the `tell` block of a specific
   * session, looked up by iTerm2 UUID via iteration (the direct
   * `session id "X"` reference pattern does not work reliably across
   * osascript process boundaries for recently-created sessions, so we
   * iterate windows → tabs → sessions within a single tell block).
   */
  private inSession(sessionId: string, operations: string, returnExpr: string = '"OK"'): string {
    if (this.windowId === null) return "";
    return this.runOsa(`
      tell application "iTerm2"
        tell window id ${this.windowId}
          repeat with t in tabs
            repeat with s in sessions of t
              if (id of s) is "${sessionId}" then
                tell s
                  ${operations}
                  return ${returnExpr}
                end tell
              end if
            end repeat
          end repeat
        end tell
      end tell
    `);
  }

  private writeTempContent(text: string): string {
    const path = join(this.tmpDir, `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(path, text, "utf-8");
    return path;
  }

  // Per-session title/badge/user-variable setup is now done inline inside
  // the atomic createWorkspace / createAgentTab AppleScript blocks.
  // Separate-process lookup of newly-created sessions by direct `session
  // id "X"` reference is unreliable; the inline approach avoids the issue
  // entirely for initial setup.

  private cleanupAndRediscover(): void {
    if (this.windowId === null) return;
    if (this.agentPanes.size === 0) {
      log().info("iterm", "No persisted agent panes to rediscover");
      return;
    }
    try {
      // Get all live session IDs in the window
      const raw = this.runOsa(`
        tell application "iTerm2"
          set out to ""
          tell window id ${this.windowId}
            repeat with t in tabs
              repeat with s in sessions of t
                set out to out & (id of s) & linefeed
              end repeat
            end repeat
          end tell
          return out
        end tell
      `).trim();

      const liveSessions = new Set(raw.split("\n").filter(Boolean));
      const stale: string[] = [];
      for (const [agent, pane] of this.agentPanes) {
        if (liveSessions.has(pane.sessionId)) {
          log().info("iterm", `${agent}: validated (session=${pane.sessionId.slice(0, 8)})`);
        } else {
          stale.push(agent);
        }
      }
      for (const agent of stale) {
        log().warn("iterm", `${agent}: session gone, removing`);
        this.agentPanes.delete(agent);
      }
      this.persistState();
      log().info("iterm", `Rediscovery: ${this.agentPanes.size} valid, ${stale.length} stale`);
    } catch (err) {
      log().warn("iterm", `Rediscovery failed: ${String(err)}`);
    }
  }

  /**
   * Load persisted windowId AND agent pane mappings from workspace.json.
   * After loading, validate that each session still exists in iTerm2.
   */
  private loadPersistedState(): void {
    try {
      if (!existsSync(this.statePath)) return;
      const raw = JSON.parse(readFileSync(this.statePath, "utf-8"));
      if (typeof raw.windowId === "number") {
        this.windowId = raw.windowId;
      }
      if (Array.isArray(raw.agentPanes)) {
        for (const entry of raw.agentPanes) {
          if (entry.agent && entry.sessionId) {
            this.agentPanes.set(entry.agent, {
              agent: entry.agent,
              sessionId: entry.sessionId,
            });
          }
        }
      }
      if (typeof raw.systemPaneId === "string") {
        this.systemPaneId = raw.systemPaneId;
      }
      log().debug(
        "iterm",
        `Loaded persisted state: window=${this.windowId}, agents=${this.agentPanes.size}`
      );
    } catch (err) {
      log().warn("iterm", `Failed to load persisted state: ${String(err)}`);
    }
  }

  private persistState(): void {
    try {
      const payload = {
        windowId: this.windowId,
        agentPanes: Array.from(this.agentPanes.values()),
        systemPaneId: this.systemPaneId,
      };
      writeFileSync(this.statePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log().warn("iterm", `Failed to persist state: ${String(err)}`);
    }
  }

  private clearPersistedState(): void {
    try {
      if (existsSync(this.statePath)) unlinkSync(this.statePath);
    } catch (err) {
      log().debug("iterm", `Clear persisted state failed: ${String(err)}`);
    }
  }

  private escapeApple(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private runOsa(script: string): string {
    return execSync("osascript", {
      input: script,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }
}
