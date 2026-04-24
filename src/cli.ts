#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { StateStore } from "./engine/state-store.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = resolve(__dirname, "..");

const program = new Command();
program.name("conductor").description("Agent Network Supervisor CLI").version("0.1.0");

function getStore(): StateStore {
  const config = loadConfig(BASE_DIR);
  return new StateStore(resolve(BASE_DIR, config.database.path));
}

program
  .command("status [agent]")
  .description("Show status of all agents or a specific agent")
  .action((agent?: string) => {
    const store = getStore();
    const sessions = store.getActiveSessions();

    if (agent) {
      const agentSessions = sessions.filter((s) => s.agent === agent);
      if (agentSessions.length === 0) {
        console.log(`No active sessions for ${agent}`);
      } else {
        for (const s of agentSessions) {
          console.log(`  ${s.id} | ${s.status} | turns: ${s.turns} | cost: $${s.cost_usd.toFixed(4)}`);
        }
      }
    } else {
      const config = loadConfig(BASE_DIR);
      for (const name of Object.keys(config.agents)) {
        const agentSessions = sessions.filter((s) => s.agent === name);
        const statusStr = agentSessions.length > 0 ? `active (${agentSessions.length} sessions)` : "idle";
        console.log(`  ${name}: ${statusStr}`);
      }
    }

    const pending = store.getPendingEscalations();
    if (pending.length > 0) {
      console.log(`\n  ${pending.length} pending escalation(s)`);
    }

    store.close();
  });

program
  .command("queue")
  .description("List pending escalations")
  .action(() => {
    const store = getStore();
    const pending = store.getPendingEscalations();

    if (pending.length === 0) {
      console.log("No pending escalations");
    } else {
      for (const e of pending) {
        console.log(`  #${e.id} | ${e.agent} | ${e.action_type} | ${e.created_at}`);
        if (e.agent_context) console.log(`    Reason: ${e.agent_context}`);
      }
    }

    store.close();
  });

program
  .command("approve <id>")
  .description("Approve an escalation")
  .option("-m, --message <msg>", "Optional note")
  .action((id: string, opts: { message?: string }) => {
    const store = getStore();
    store.resolveEscalation(parseInt(id, 10), "approved", "operator", opts.message);
    console.log(`Escalation #${id} approved`);
    store.close();
  });

program
  .command("deny <id>")
  .description("Deny an escalation")
  .option("-m, --message <msg>", "Optional note")
  .action((id: string, opts: { message?: string }) => {
    const store = getStore();
    store.resolveEscalation(parseInt(id, 10), "denied", "operator", opts.message);
    console.log(`Escalation #${id} denied`);
    store.close();
  });

program
  .command("logs [agent]")
  .description("Show recent health log entries")
  .option("-n, --count <n>", "Number of entries", "20")
  .action((agent: string | undefined, opts: { count: string }) => {
    const store = getStore();
    const limit = parseInt(opts.count, 10);

    if (agent) {
      const events = store.getHealthLog(agent, limit);
      if (events.length === 0) {
        console.log(`No health events for ${agent}`);
      } else {
        for (const e of events) {
          console.log(`  ${e.timestamp} | ${e.event} | ${e.detail ?? ""}`);
        }
      }
    } else {
      const config = loadConfig(BASE_DIR);
      for (const name of Object.keys(config.agents)) {
        const events = store.getHealthLog(name, 5);
        if (events.length > 0) {
          console.log(`  ${name}:`);
          for (const e of events) {
            console.log(`    ${e.timestamp} | ${e.event}`);
          }
        }
      }
    }

    store.close();
  });

program
  .command("focus")
  .description("Bring the iTerm2 conductor window to the foreground")
  .action(() => {
    const workspacePath = resolve(BASE_DIR, "data", "workspace.json");
    if (!existsSync(workspacePath)) {
      console.log("No conductor workspace. Run 'make start' first.");
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(workspacePath, "utf-8"));
      if (typeof raw.windowId !== "number") {
        console.log("Invalid workspace state.");
        return;
      }
      execSync("osascript", {
        input: `tell application "iTerm2"\n  activate\n  try\n    select window id ${raw.windowId}\n  end try\nend tell\n`,
      });
      console.log(`Focused iTerm2 window ${raw.windowId}.`);
    } catch (err) {
      console.error(`Focus failed: ${String(err)}`);
    }
  });

const LABEL = "com.agent-conductor.local";
const PLIST_DEST = resolve(process.env.HOME ?? "~", "Library", "LaunchAgents", `${LABEL}.plist`);

function generatePlist(): string {
  const nodePath = process.execPath;
  const entryPoint = resolve(BASE_DIR, "dist", "index.js");
  const home = process.env.HOME ?? "/tmp";
  const pathEnv = `${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${entryPoint}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>/tmp/agent-conductor.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/agent-conductor.stderr.log</string>

    <key>WorkingDirectory</key>
    <string>${BASE_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${pathEnv}</string>
        <key>HOME</key>
        <string>${home}</string>
    </dict>

    <key>ProcessType</key>
    <string>Interactive</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
`;
}

program
  .command("daemon")
  .description("Daemon management")
  .addCommand(
    new Command("install").description("Generate and install launchd plist").action(() => {
      const plist = generatePlist();
      writeFileSync(PLIST_DEST, plist);
      console.log(`Plist written to ${PLIST_DEST}`);
      console.log(`Run: launchctl bootstrap gui/$(id -u) ${PLIST_DEST}`);
    })
  )
  .addCommand(
    new Command("uninstall").description("Remove launchd plist").action(() => {
      try {
        execSync(`launchctl bootout gui/$(id -u)/${LABEL}`, { stdio: "ignore" });
      } catch { /* may not be loaded */ }
      if (existsSync(PLIST_DEST)) {
        execSync(`rm ${PLIST_DEST}`);
        console.log(`Removed ${PLIST_DEST}`);
      } else {
        console.log("Plist not found — nothing to remove.");
      }
    })
  )
  .addCommand(
    new Command("start").description("Start the daemon").action(() => {
      console.log(`  launchctl kickstart gui/$(id -u)/${LABEL}`);
    })
  )
  .addCommand(
    new Command("stop").description("Stop the daemon").action(() => {
      console.log(`  launchctl bootout gui/$(id -u)/${LABEL}`);
    })
  );

program.parse();
