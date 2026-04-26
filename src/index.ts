#!/usr/bin/env node

import { Supervisor } from "./supervisor.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = resolve(__dirname, "..");

mkdirSync(resolve(BASE_DIR, "data"), { recursive: true });

const supervisor = new Supervisor(BASE_DIR);

process.on("SIGINT", async () => {
  await supervisor.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await supervisor.stop();
  process.exit(0);
});

const startAll = process.argv.includes("--start-all");
const headless = process.argv.includes("--headless");

supervisor.start({ startAll }).then(() => {
  if (headless || !process.stdin.isTTY) return;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "conductor> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === "exit" || trimmed === "quit") {
      await supervisor.stop();
      process.exit(0);
    }

    const response = await supervisor.handleCliCommand(trimmed);
    if (response) console.log(response);
    rl.prompt();
  });

  rl.on("close", async () => {
    await supervisor.stop();
    process.exit(0);
  });
}).catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
