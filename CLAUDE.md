# Agent Conductor — Developer Guide

## What This Is

A Node.js supervisor that manages multiple Claude Code instances in iTerm2 on macOS. It routes messages between agents (and between agents and the operator via Telegram), monitors health, auto-nudges stalled sessions, and enforces rate limits. One process, one iTerm2 window (or many — panes can be moved freely).

## Quick Reference

```bash
make start          # Start conductor (foreground)
make start-all      # Start conductor + all agents
npx tsc --noEmit    # Type check (do this before committing)
npx vitest run      # Run tests
```

## Architecture at a Glance

The supervisor (`src/supervisor.ts`, ~1900 lines) is the hub. Everything routes through it.

```
Telegram ──► Supervisor ◄── CLI (primary pane)
                │
      ┌─────────┼─────────┐
      ▼         ▼         ▼
  ModeManager  MCP Server  HealthMonitor
  (agent state) (agent tools) (stall detection)
      │         │         │
      └─────────┼─────────┘
                ▼
         IterminalWorkspace
         (AppleScript → iTerm2)
                │
        ┌───────┼───────┐
        ▼       ▼       ▼
     Agent    Agent    Agent
     Pane     Pane     Pane
```

### Data Flow for Agent Communication

1. Agent A calls MCP tool `send_to_agent` → HTTP POST to `/mcp/agentA`
2. `server.ts` extracts caller identity from URL path ("agentA")
3. `tools.ts` handler receives `caller`, builds envelope `[Message from agentA]`
4. `supervisor.sendToAgent()` → `workspace.runInPane()` → AppleScript writes to Agent B's pane

### Data Flow for Stall Detection

1. `health-monitor.ts` captures pane contents every 30s
2. Content unchanged → `onStall` callback fires
3. `supervisor.handleStallDetection()` checks auto-responses, compaction, sleep markers
4. For auto/approve mode: `stall-judge.ts` calls Claude Haiku to classify + draft nudge
5. Auto: delivers nudge directly. Approve: sends to Telegram for operator sign-off.

## Source Layout

| File | What it does | When to touch it |
|------|-------------|-----------------|
| `src/supervisor.ts` | Main orchestrator — agent lifecycle, Telegram commands, stall routing, MCP wiring | Adding commands, changing agent behavior |
| `src/transport/iterm.ts` | iTerm2 AppleScript driver — pane/tab/window creation, message delivery, capture | Fixing iTerm2 communication issues |
| `src/mcp/tools.ts` | All MCP tool definitions agents can call | Adding/changing agent-callable tools |
| `src/mcp/server.ts` | HTTP MCP server with per-agent URL routing | Changing protocol or auth |
| `src/session/agent-session.ts` | Builds the `claude` CLI command, manages pane lifecycle | Changing how agents are launched |
| `src/session/mode-manager.ts` | Per-agent state: autonomy, nudge level, tags, pause. Persists to `data/mode-state.json` | Adding new per-agent state |
| `src/session/types.ts` | Shared types: Autonomy, NudgeLevel, PanePlacement, AgentState | Adding new enum/state types |
| `src/engine/health-monitor.ts` | Pane-content-based stall detection loop | Changing stall detection logic |
| `src/intelligence/stall-judge.ts` | Claude Haiku one-shot for stall classification + nudge drafting | Changing nudge behavior |
| `src/engine/scheduler.ts` | Cron scheduler with hot-reload and missed-schedule recovery | Changing scheduled task behavior |
| `src/engine/state-store.ts` | SQLite persistence (sessions, health events, escalations, messages) | Adding new persistent data |
| `src/config.ts` | YAML config loader for supervisor + agent configs | Adding new config fields |
| `src/transport/telegram.ts` | Telegram bot polling + message routing | Changing Telegram integration |

## Key Design Decisions

**iTerm2 sessions are tracked by UUID, searched across all windows.** The AppleScript in `inSession()` iterates every window's tabs and sessions — not just the conductor window. This means panes moved to other windows still work. Only pane *creation* targets the conductor window.

**Caller identity is mechanical, not self-declared.** Each agent gets a per-agent MCP config pointing to `/mcp/<codename>`. The server extracts the codename from the URL path and passes it to tool handlers as `caller`. Agents cannot impersonate each other. The `from` parameter was removed from all MCP tool schemas.

**Agent configs are hot-reloaded.** YAML files in `config/agents/` are re-read every heartbeat interval (~30s). New files register agents; removed files deregister idle agents. No restart needed.

**State is split between SQLite and JSON.** Transactional data (sessions, escalations, health events, messages) lives in SQLite via `state-store.ts`. Mode state (autonomy, nudge levels, tags) lives in `data/mode-state.json` via `mode-manager.ts`. Workspace state (window ID, pane mappings) lives in `data/workspace.json` via `iterm.ts`.

## Patterns to Follow

**Adding a new per-agent setting** (like tag, nudge level):
1. Add field to `AgentState` in `types.ts`
2. Initialize it in `ModeManager` constructor and `addAgent()`
3. Add getter/setter methods in `ModeManager`
4. Add to `persistState()` and `loadPersistedState()` in `ModeManager`
5. Add to `AgentStatusReport` in `supervisor.ts` and populate in `getAgentStatus()`
6. Include in `formatAgentLine()` for status display
7. Add CLI command in `handleTelegramCommand()` + help text in `buildHelpMessage()`
8. Add MCP tool in `tools.ts` + wire deps in supervisor constructor

**Adding a new MCP tool:**
1. Add handler function signature to `McpToolDeps` type in `tools.ts`
2. Add tool definition with `inputSchema` and `handler` in `buildMcpTools()`
3. Handler receives `(args, caller)` — use `caller` for identity, never trust args
4. Wire the dep in the supervisor constructor's `buildMcpTools({...})` call
5. For orchestration tools: use `deps.checkOrchestrationPolicy(caller, verb, target)`

**Adding a new Telegram/CLI command:**
1. Add case to `handleTelegramCommand()` switch in `supervisor.ts`
2. Add help text to `buildHelpMessage()`
3. Update README.md command reference
4. The CLI client hits the same handler via `/cmd` endpoint, so both work automatically

## Common Gotchas

- **AppleScript string escaping**: Use `this.escapeApple()` for any user-provided strings going into AppleScript. Unescaped quotes break the entire osascript call.
- **Shell init race**: New panes need time for zsh to boot. Use `launchInPane()` (which polls for a prompt marker) for the first command, `runInPane()` for subsequent ones.
- **Multi-line messages**: Must use bracketed paste mode (ESC[200~ ... ESC[201~) or the shell treats embedded newlines as submit keystrokes. `runInPane()` handles this automatically.
- **The system pane** uses the shared MCP config at `/mcp` (no agent suffix), which gets `caller = "unknown"`. Don't add identity-dependent logic to tools without handling this case.
- **`execSync` in iterm.ts blocks the event loop.** Each AppleScript call is synchronous. This is acceptable for one-off operations but don't add loops that call `runOsa` many times in sequence.

## Build & Run

- **Runtime**: Node.js 22+, pnpm, tsx (runs TypeScript directly — no build step for dev)
- **Type check**: `npx tsc --noEmit` — always run before committing
- **Tests**: `npx vitest run`
- **No build needed for `make start`** — tsx executes `.ts` source directly
- **`make build`** compiles to `dist/` (needed for daemon mode only)

## Configuration Files

- `config/supervisor.yaml` — global settings (heartbeat, thresholds, models, Telegram, MCP port)
- `config/agents/<codename>.yaml` — per-agent config (repo path, model, schedules, peer access)
- `.env` — `CONDUCTOR_TELEGRAM_TOKEN` and `CONDUCTOR_TELEGRAM_CHAT_ID`
- `config/system-prompt-base.txt` — base system prompt appended to all agents
- `config/system-prompt-cognitive.txt` — additional prompt for cognitive-template agents

## Runtime Data (gitignored)

- `data/conductor.db` — SQLite (sessions, escalations, health events)
- `data/mode-state.json` — autonomy, nudge levels, tags per agent
- `data/workspace.json` — iTerm2 window ID + pane session UUIDs
- `data/mcp-configs/` — per-agent MCP config files (auto-generated)
- `data/conductor.log` — structured log file
