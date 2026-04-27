#!/usr/bin/env node
// Lightweight interactive CLI client for the Agent Conductor.
// Connects to the conductor's /cmd HTTP endpoint.
// Launched automatically in the primary pane of the conductor window.

import { createInterface } from "readline";
import http from "http";

const port = parseInt(process.argv[2] || "3456", 10);

function sendCommand(command) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ command });
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/cmd", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            resolve(body.response || body.error || "");
          } catch {
            resolve(Buffer.concat(chunks).toString());
          }
        });
      }
    );
    req.on("error", (err) => resolve(`Connection error: ${err.message}`));
    req.end(data);
  });
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${RED}conductor>${RESET} ` });

console.log("Agent Conductor CLI (connected to localhost:" + port + ")");
console.log("Type /help for commands, /status for overview, 'exit' to quit.\n");
rl.prompt();

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) { rl.prompt(); return; }
  if (trimmed === "exit" || trimmed === "quit") { process.exit(0); }
  if (trimmed === "/c") { console.clear(); rl.prompt(); return; }

  const response = await sendCommand(trimmed);
  if (response) console.log(response);
  rl.prompt();
});

rl.on("close", () => process.exit(0));
