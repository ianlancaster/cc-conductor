import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",  // gray
  info: "\x1b[36m",   // cyan
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
};

const RESET = "\x1b[0m";

export class Logger {
  private minLevel: number;
  private logFilePath: string | null;

  constructor(level: LogLevel = "info", logFilePath?: string) {
    this.minLevel = LEVEL_ORDER[level];

    if (logFilePath) {
      mkdirSync(dirname(logFilePath), { recursive: true });
      this.logFilePath = logFilePath;
    } else {
      this.logFilePath = null;
    }
  }

  debug(component: string, message: string, meta?: Record<string, unknown>) {
    this.log("debug", component, message, meta);
  }

  info(component: string, message: string, meta?: Record<string, unknown>) {
    this.log("info", component, message, meta);
  }

  warn(component: string, message: string, meta?: Record<string, unknown>) {
    this.log("warn", component, message, meta);
  }

  error(component: string, message: string, meta?: Record<string, unknown>) {
    this.log("error", component, message, meta);
  }

  private log(level: LogLevel, component: string, message: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const timestamp = new Date().toISOString();
    const metaStr = meta ? " " + JSON.stringify(meta) : "";

    // Console: colored
    const color = LEVEL_COLORS[level];
    const tag = level.toUpperCase().padEnd(5);
    console.log(
      `${"\x1b[90m"}${timestamp}${RESET} ${color}${tag}${RESET} [${component}] ${message}${metaStr}`
    );

    // File: plain
    if (this.logFilePath) {
      const line = `${timestamp} ${tag} [${component}] ${message}${metaStr}\n`;
      try {
        appendFileSync(this.logFilePath, line);
      } catch {
        // Don't crash if log write fails
      }
    }
  }
}

let globalLogger: Logger | null = null;

export function initLogger(level: LogLevel, logFilePath?: string): Logger {
  globalLogger = new Logger(level, logFilePath);
  return globalLogger;
}

export function log(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger("info");
  }
  return globalLogger;
}
