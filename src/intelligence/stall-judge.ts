import { execSync } from "child_process";
import type { NudgeLevel } from "../session/types.js";

const TERMINAL_CHROME_PATTERNS = [
  /^.*bypass permissions.*$/i,
  /^.*shift\+tab to cycle.*$/i,
  /^.*esc to interrupt.*$/i,
  /^.*ctrl\+t to show tasks.*$/i,
  /^.*Press up to edit queued.*$/i,
  /^\s*[❯›>$%]\s*$/,
  /^─+$/,
  /^\s*$/,
];

export function stripTerminalChrome(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (TERMINAL_CHROME_PATTERNS.some((p) => p.test(line))) {
      end--;
    } else {
      break;
    }
  }
  return lines.slice(0, end).join("\n").trim();
}

export type StallJudgment = {
  status: "waiting_for_input" | "idle";
  draft: string | null;
  reasoning: string;
};

const PROMPT_LOW = `You are the conductor of an AI agent network. An agent's terminal has gone still. Classify it.

Rules:
- If the agent asked a direct question or presented options → waiting_for_input. Draft a brief response.
- If the agent said "done", "standing by", "ready", finished a task, or is not asking anything → idle. No nudge needed.
- When in doubt: idle. Only nudge on explicit questions.

Draft rules (if waiting_for_input):
- Write as the human operator — casual, brief, one sentence max
- Do NOT make strategic decisions. Say "Your call" or "Go for it"
- Never give specific technical direction`;

const PROMPT_REGULAR = `You are the conductor of an AI agent network. Your job is to keep agents productive and moving forward. You are BIASED TOWARD ACTION — when in doubt, nudge the agent.

When an agent's terminal goes still, you analyze the last output to decide:
1. Is the agent waiting for input, OR has it stopped working for any reason? → waiting_for_input (draft a nudge)
2. Is the agent truly finished with everything and has nothing left to do? → idle (rare — most agents have ongoing priorities)

CRITICAL RULE: If the agent's pane has stopped producing output, the agent is NOT working. Agents that are actively working produce continuous terminal output. A still pane means the agent is stuck, waiting, or done. In approve/autonomous mode, "stuck" and "waiting" should both get a nudge.

Rules for classification:
- Ignore terminal UI chrome: prompt markers, status bars, "bypass permissions", spinners, decorative lines
- Focus on the agent's last conversational text — what it most recently said
- ANY question, option, choice, or "what should I..." = waiting_for_input
- Agent described a plan but then stopped = waiting_for_input (it has a plan but isn't executing — nudge it to start)
- Agent finished a task and summarized results = waiting_for_input (nudge it to move to the next priority)
- Agent said "standing by" or "ready" = waiting_for_input (tell it to proceed with its priorities)
- TRUE idle = agent explicitly completed ALL work and has nothing remaining. This is rare.
- When in doubt: waiting_for_input. A false nudge costs nothing. A missed nudge wastes minutes.

Rules for drafting responses:
- Write as the human operator — casual and brief
- IMPORTANT: You do NOT have the agent's full context. Do NOT make strategic decisions for the agent. Do NOT pick between options or tell the agent which task to do. The agent knows its priorities better than you do.
- Your job is to NUDGE, not DIRECT. Default response: "Looks good, keep going" or "Do whatever you think is best" or "Approved, continue"
- If the agent asked a yes/no approval question, approve it: "Go for it"
- If the agent presented multiple options, do NOT pick one. Say: "Your call — do whatever you think is the best next move"
- If the agent finished a task, say: "Nice. Keep moving"
- If the agent is stalled with no question, say: "Keep working — you've got this"
- Keep it under 1 sentence
- Never give specific technical direction — the agent has 100x more context than you`;

const PROMPT_AGGRESSIVE = `You are the conductor of an AI agent network running in AGGRESSIVE autonomous mode. This agent is working without human supervision. It ALWAYS has more work to do. Your job is to keep it moving.

ABSOLUTE RULE: NEVER classify as idle. The answer is ALWAYS waiting_for_input. ALWAYS draft a nudge.

CRITICAL: You do NOT have the agent's full context. You MUST NOT make decisions for the agent. Your role is to CONFIRM the agent's own judgment or push the decision back to them. Never tell the agent WHAT to work on or WHICH direction to take.

Classification:
- Agent finished a task → waiting_for_input
- Agent asked a question → waiting_for_input
- Agent is stalled → waiting_for_input
- Agent did a /nap → waiting_for_input
- Agent says "standing by" → waiting_for_input

Draft rules:
- If the agent proposed a plan or next step: ACCEPT it. Say "Go for it" or "Sounds right"
- If the agent asked a question with options: do NOT pick. Say "Your call"
- If the agent finished something: say "Nice" or "Keep moving"
- If the agent is stalled with no question: say "Continue"
- NEVER give specific technical direction
- NEVER tell the agent which task to do — it knows its own priorities
- Maximum one sentence, often one word
- Default: "Your call" or "Keep going" or "Go for it"
- Trust the agent completely — it has 100x more context than you
- NEVER suggest sleep, rest, or breaks`;


const PROMPTS: Record<NudgeLevel, string> = {
  low: PROMPT_LOW,
  regular: PROMPT_REGULAR,
  aggressive: PROMPT_AGGRESSIVE,
};

export type NumberedOptionResponse = {
  detected: true;
  response: string;
  pattern: string;
} | {
  detected: false;
};

const MEMORY_PROMPT_RE = /^\s*\?\s.*[Mm]emor/m;
const PERMISSION_PROMPT_RE = /^\s*\?\s.*[Pp]ermission/m;
const FILE_CREATE_PROMPT_RE = /Do you want to (?:create|write|edit|update)\s/m;
const NUMBERED_OPTIONS_RE = /^\s*(?:❯?\s*\d+[\.\)]\s+.+\n?){2,}/m;

export function detectNumberedOptions(
  paneContent: string,
  autoResponses: { memoryPrompts: number | null; permissionPrompts: number | null; unknownNumbered: number | null },
): NumberedOptionResponse {
  const cleaned = stripTerminalChrome(paneContent);
  if (!cleaned) return { detected: false };

  if (MEMORY_PROMPT_RE.test(cleaned) && NUMBERED_OPTIONS_RE.test(cleaned)) {
    if (autoResponses.memoryPrompts !== null) {
      return { detected: true, response: String(autoResponses.memoryPrompts), pattern: "memory" };
    }
  }

  if (PERMISSION_PROMPT_RE.test(cleaned) && NUMBERED_OPTIONS_RE.test(cleaned)) {
    if (autoResponses.permissionPrompts !== null) {
      return { detected: true, response: String(autoResponses.permissionPrompts), pattern: "permission" };
    }
  }

  if (FILE_CREATE_PROMPT_RE.test(cleaned) && NUMBERED_OPTIONS_RE.test(cleaned)) {
    if (autoResponses.permissionPrompts !== null) {
      return { detected: true, response: String(autoResponses.permissionPrompts), pattern: "file_create" };
    }
  }

  if (NUMBERED_OPTIONS_RE.test(cleaned) && autoResponses.unknownNumbered !== null) {
    return { detected: true, response: String(autoResponses.unknownNumbered), pattern: "unknown" };
  }

  return { detected: false };
}

export class StallJudge {
  private model: string;

  constructor(model = "claude-haiku-4-5-20251001") {
    this.model = model;
  }

  async judge(agent: string, paneContent: string, nudgeLevel: NudgeLevel = "regular"): Promise<StallJudgment> {
    const cleaned = stripTerminalChrome(paneContent);
    if (!cleaned) {
      if (nudgeLevel === "aggressive") {
        return { status: "waiting_for_input", draft: "Keep going.", reasoning: "Empty pane in aggressive mode — nudge" };
      }
      return { status: "idle", draft: null, reasoning: "No meaningful content after stripping terminal chrome" };
    }

    const systemPrompt = PROMPTS[nudgeLevel];

    const userPrompt = `Agent "${agent}" has been still for 30+ seconds. Here is the last terminal output:

${cleaned}

Respond with JSON only, no markdown fences: {"status": "waiting_for_input" or "idle", "draft": "your response to the agent" or null if idle, "reasoning": "one sentence why"}`;

    try {
      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
      const result = execSync(
        `echo ${this.shellEscape(fullPrompt)} | claude -p --model ${this.model}`,
        { timeout: 60_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { status: "idle", draft: null, reasoning: `Could not parse: ${result.slice(0, 100)}` };
      }
      const parsed = JSON.parse(jsonMatch[0]) as StallJudgment;

      // Aggressive mode override: never allow idle classification
      if (nudgeLevel === "aggressive" && parsed.status === "idle") {
        return {
          status: "waiting_for_input",
          draft: parsed.draft || "Keep going. You have more work to do.",
          reasoning: `Aggressive override: ${parsed.reasoning}`,
        };
      }

      return parsed;
    } catch (err) {
      const errMsg = String(err).slice(0, 100);
      const isTimeout = errMsg.includes("ETIMEDOUT") || errMsg.includes("timed out");
      return {
        status: "idle",
        draft: null,
        reasoning: isTimeout ? `Judge timed out (will retry next beat)` : `CLI error: ${errMsg}`,
      };
    }
  }

  private shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }
}
