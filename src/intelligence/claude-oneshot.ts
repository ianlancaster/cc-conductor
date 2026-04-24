import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class ClaudeOneShot {
  private binary: string;
  private cwd: string;

  constructor(binary: string, cwd: string) {
    this.binary = binary;
    this.cwd = cwd;
  }

  async ask(question: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        this.binary,
        ["-p", question, "--bare", "--max-turns", "1", "--output-format", "json"],
        { cwd: this.cwd, timeout: 60_000, maxBuffer: 1024 * 1024 }
      );

      const parsed = JSON.parse(stdout) as { result?: string };
      return parsed.result ?? stdout;
    } catch (err) {
      return `Claude Code one-shot failed: ${err}`;
    }
  }
}
