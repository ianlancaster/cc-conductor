# Agent Conductor

An always-on supervisor for Claude Code sessions. Manages multiple Claude Code instances in iTerm2 panes, routes messages between them and the operator (via Telegram), monitors health with configurable nudge aggressiveness, auto-nudges stalled sessions, enforces rate limits, and recovers missed cron schedules after Mac sleep — all from a single process.

Works with any Claude Code session. Optional deep integration with cognitive-template agents (persistent AI agents with memory, rituals, and inter-agent communication).

## Prerequisites

- **Node.js 22+** (installed via nvm)
- **iTerm2** (macOS)
- **Telegram account** with a bot created via [@BotFather](https://t.me/BotFather)

## Quick Start

```bash
# Clone and install
git clone <repo-url> agent-conductor
cd agent-conductor
pnpm install

# Create .env with Telegram credentials
echo "CONDUCTOR_TELEGRAM_TOKEN=<from BotFather>" > .env
echo "CONDUCTOR_TELEGRAM_CHAT_ID=<your chat ID>" >> .env

# Register an agent — copy the example and edit
cp config/agents/example.yaml config/agents/my-project.yaml
# Edit my-project.yaml: set codename, repo path, model

# Start
make start          # Start conductor only
make start-all      # Start conductor + all registered agents
make focus          # Bring iTerm2 window to front
```

The conductor creates an iTerm2 window with panes for each agent. Sessions persist across conductor restarts — pane mappings are saved to `data/workspace.json` and validated against live iTerm2 sessions on startup.

## Telegram Commands

```
Sessions:
  /status                     Agent overview with activity status
  /start <agent|all>          Start a session (or all)
  /stop <agent|all>           Stop a session (or all)
  /continue <agent|all>       Resume last session (or all)

Conversation:
  /talk <agent>               Set conversation target (/speak alias)
  /tell <agent> <msg>         Start with a directive
  /<agent> <msg>              Shortcut for talk+send
  /broadcast <msg>            Send message to all active agents
  //<cmd>                     Forward slash command to talk target

Lifecycle:
  /spawn <name> [opts]        Create bare instance + start
                              --path /dir  --model model  --prompt "text"
  /spawn-agent <name>         Clone cognitive template + /awaken
  /teardown <name> [--delete] Stop + deregister (--delete removes directory)

Modes:
  /auto <agent|all>           Autonomous mode
  /approve <agent|all>        Approve mode
  /facil <agent|all>          Facilitated mode (/facilitated alias)
  /nudge <agent|all> <level>  Set nudge aggressiveness (low|regular|aggressive)
  /pause <agent|all>          Temp switch to facilitated, remember previous mode
  /resume <agent|all>         Restore previous mode
  /autopause [on|off]         Auto-pause agents when their pane is focused

Escalations:
  /approve <id>               Approve an escalation
  /deny <id>                  Deny an escalation
  /queue                      Pending escalations
  /clear                      Dismiss all pending escalations

CLI:
  /c                          Clear terminal output
  /tail <agent> [lines]       Capture agent's pane (default 30)
```

Use `all` in place of an agent name to target every registered agent at once.

Tip: type "yes"/"no" to approve/deny when there's one pending escalation.

## Three Autonomy Modes

**Facilitated** (default): You drive the conversation. Agent responses go to terminal. When you message from Telegram, `CONDUCTOR_REMOTE_ACTIVE` is appended so the agent replies via both terminal and Telegram.

**Approve**: Agents work autonomously. When one stalls, the conductor captures the pane, calls Claude Haiku to classify and draft a nudge. You see the agent's output + recommended nudge in Telegram with buttons: Send it / Don't nudge / Custom nudge.

**Autonomous**: Same as approve, but the conductor delivers the nudge automatically. Audit trail sent to Telegram as FYI.

Response labeling: `[Approved]`, `[Approved — custom]`, or `[Auto]` prefixes tell the agent the response source.

## Nudge Aggressiveness

Controls how aggressively the conductor pushes stalled agents. Set per-agent: `/nudge my-agent aggressive`

| Level | Behavior |
|-------|----------|
| **low** | Only nudge on explicit questions. "Standing by" = idle. |
| **regular** (default) | Nudge on questions + task completion. "Standing by" = nudge. Agent says "goodnight" = idle. |
| **aggressive** | NEVER classify as idle. For overnight autonomous runs. |

## Agent Activity Status

The `/status` command shows real-time activity:

| Icon | Status | Meaning |
|------|--------|---------|
| 🟢 | `working` | Pane is producing output |
| 🟡 | `stalled` | Pane is still, stall judge invoked |
| 🔵 | `awaiting_approval` | Pending escalation |
| ⚪ | `stopped` | No active session |

Cognitive-template agents appear under **Agents**; generic Claude Code instances appear under **Instances**.

## MCP Tools (Agent-to-Agent Communication)

The conductor runs an HTTP MCP server on `localhost:3456`. Agents connect via `--mcp-config data/conductor-mcp.json`.

### Communication
| Tool | Description |
|------|-------------|
| `respond_to_user` | Send a response to the operator via Telegram |
| `send_to_agent` | Fire-and-forget message to a peer's active pane |
| `broadcast` | Send to all active peers' panes immediately |
| `request_human_input` | Ask the operator a question and block for response |
| `notify_agents` | Queue notification for agents |

### Orchestration
| Tool | Description |
|------|-------------|
| `start_agent` | Start a peer's session |
| `stop_agent` | Stop a peer's session |
| `continue_agent` | Resume a peer's last session |
| `set_autonomy` | Set a peer's autonomy mode |
| `spawn_agent` | Create + register + start a new instance |
| `teardown_agent` | Stop + deregister + optionally delete an instance |

### Context Management
| Tool | Description |
|------|-------------|
| `request_context` | Trigger /context in your pane (async) |
| `request_restart` | Full session teardown and fresh start |

### Observability
| Tool | Description |
|------|-------------|
| `list_agents` | All agents with status |
| `get_agent_status` | Detailed status for one agent |
| `list_escalations` | Pending escalation queue |

## Health Monitor

Pane-content-based stall detection runs every 30 seconds:

1. Captures the last 40 lines of each active agent's pane
2. Compares with the previous capture
3. Pane changed → `working`
4. Pane unchanged 30+ seconds → `stalled`, stall judge invoked
5. **Compaction check**: if "Compacted" appears, sends a resumption nudge
6. **Numbered options**: settings permission prompts ("Yes, and allow Claude to edit its own settings") are auto-approved for ALL agents regardless of mode
7. **Facilitated**: all other stalls ignored (operator is driving)
8. **Approve/Auto**: Claude Haiku classifies and drafts a response per nudge level

## Rate Limit Monitoring

A dedicated `_system` pane runs an idle Claude Code session for `/usage` queries.

- Every 5 minutes, captures usage percentages
- **At threshold** (session ≥ 80% or weekly ≥ 70%): sends `[RATE LIMIT]` to all active agents + Telegram alert
- **Below threshold** after pause: sends `[RATE LIMIT CLEARED]`
- Thresholds configurable in `supervisor.yaml`

## Cron Scheduler

Agents can have scheduled tasks in their config YAML:

```yaml
schedules:
  - label: nightly-task
    cron: "0 22 * * *"
    prompt: "Wrap up and summarize today's work."
    paused: false
    freshSession: false
```

Features:
- Full 5-field cron syntax
- Fires once per matching minute for active agents; skips if agent is not running
- **Hot-reload**: re-reads YAML configs every 5 minutes
- **Pausing**: set `paused: true` to skip a scheduled task
- **Fresh sessions**: `freshSession: true` stops old session before starting new
- **Pause-aware**: crons are deferred while an agent is `/pause`d

## Cognitive Template Integration

The conductor automatically detects cognitive-template agents by checking for a `.cognitive-agent` marker file in the agent's repo root. When detected:

- **Post-sleep restart**: detects completed `/sleep` rituals and auto-restarts with `/caffeinate`
- **Cognitive compaction nudge**: references cognitive files (context/current-state.md, etc.)
- **Rate limit message**: tells the agent to `/nap` instead of generic "save your work"
- **Restart cycle**: runs `/sleep` → teardown → `/caffeinate` instead of plain stop/start
- **System prompt**: appends cognitive-specific extensions (ritual instructions)
- **Status display**: listed under "Agents" instead of "Instances"

Generic Claude Code instances get sensible defaults for all of these behaviors without any cognitive-template dependency.

To mark an agent as cognitive, create the marker: `touch /path/to/my-agent/.cognitive-agent`

## Agent Launch Environment

All agents launched by the conductor receive:

| Variable | Value | Purpose |
|----------|-------|---------|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `70` | Auto-compact at 70% context |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | Conductor manages memory |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | `1` | No human for surveys |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | `1` | Conductor manages titles |
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` | `1` | Auto-resume on crash |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | No telemetry |
| `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` | `0` | Disable recap (interferes with stall detection) |

Plus:
- `--mcp-config` pointing to the conductor's MCP server
- `--append-system-prompt-file` with the conductor protocol (+ cognitive extensions if detected)
- `--dangerously-skip-permissions` for autonomous operation
- `--add-dir` for any configured additional directories

## Configuration

### `config/supervisor.yaml`

```yaml
supervisor:
  heartbeatIntervalSeconds: 30
  stallThresholdMinutes: 5
  stallRestartAttempts: 1
  defaultMaxTurns: 100
  logLevel: debug
  usageSessionThreshold: 80
  usageWeeklyThreshold: 70
```

### `config/agents/<codename>.yaml`

See `config/agents/example.yaml` for generic instances and `config/agents/example-cognitive.yaml` for cognitive-template agents.

## Project Structure

```
agent-conductor/
├── src/
│   ├── index.ts                  Entry point
│   ├── supervisor.ts             Main orchestrator
│   ├── config.ts                 YAML config loader
│   ├── engine/
│   │   ├── health-monitor.ts     Pane-content stall detection
│   │   ├── scheduler.ts          Cron scheduler + missed-schedule recovery
│   │   ├── state-store.ts        SQLite persistence
│   │   ├── escalation-queue.ts   Escalation state machine
│   │   ├── permission-engine.ts  Policy evaluation
│   │   └── orchestration-policy.ts  Blacklist-based peer policy
│   ├── transport/
│   │   ├── iterm.ts              iTerm2 workspace (AppleScript)
│   │   └── telegram.ts           Telegram bot + conversation proxy
│   ├── session/
│   │   ├── agent-session.ts      Claude CLI session lifecycle
│   │   ├── mode-manager.ts       Autonomy + nudge level + activity status
│   │   └── types.ts              Autonomy, NudgeLevel, ActivityStatus
│   ├── mcp/
│   │   ├── server.ts             HTTP MCP server
│   │   └── tools.ts              All MCP tool definitions
│   └── intelligence/
│       └── stall-judge.ts        Three nudge levels (low/regular/aggressive)
├── config/
│   ├── supervisor.yaml           Global settings
│   ├── system-prompt-base.txt    Base protocol (all agents)
│   ├── system-prompt-cognitive.txt  Cognitive extensions (marker-detected)
│   └── agents/                   Per-agent config (hot-reloaded)
├── data/                         Runtime state (gitignored)
├── docs/
├── Makefile
└── .env                          Telegram credentials (gitignored)
```

## Daemon (launchd)

```bash
make daemon-install    # Generate plist from current environment and install
make daemon-restart    # Restart the daemon
make daemon-uninstall  # Stop and remove
make daemon-status     # Check if running
make daemon-logs       # Tail stdout/stderr logs
```
