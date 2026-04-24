#!/usr/bin/env node

import { Supervisor } from "./supervisor.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

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

supervisor.start({ startAll }).catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
