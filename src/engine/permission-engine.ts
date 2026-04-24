import { minimatch } from "minimatch";
import type { AgentPolicy } from "../config.js";
import { log } from "../logger.js";

export type PermissionDecision = {
  behavior: "allow" | "deny" | "escalate";
  tier: 1 | 2 | 3;
  reason: string;
};

export class PermissionEngine {
  evaluate(
    policy: AgentPolicy,
    toolName: string,
    input: Record<string, unknown>
  ): PermissionDecision {
    const inputSummary = toolName === "Bash"
      ? (input.command as string)?.slice(0, 60) ?? ""
      : `${toolName}(${JSON.stringify(input).slice(0, 60)})`;

    if (policy.escalateAlways.length > 0 && this.matchesEscalateAlways(policy, toolName, input)) {
      log().warn("permission", `${policy.codename} ESCALATE(T3): ${inputSummary} — escalateAlways match`);
      return { behavior: "escalate", tier: 3, reason: "Path matches escalateAlways" };
    }

    if (toolName === "Bash") {
      const result = this.evaluateBash(policy, input);
      log().debug("permission", `${policy.codename} ${result.behavior.toUpperCase()}(T${result.tier}): ${inputSummary}`);
      return result;
    }

    if (policy.autoApprove.tools.includes(toolName)) {
      log().debug("permission", `${policy.codename} ALLOW(T1): ${inputSummary}`);
      return { behavior: "allow", tier: 1, reason: `${toolName} in auto-approve list` };
    }

    return { behavior: "escalate", tier: 2, reason: `${toolName} not in auto-approve list` };
  }

  private evaluateBash(policy: AgentPolicy, input: Record<string, unknown>): PermissionDecision {
    const command = (input.command as string) ?? "";

    for (const pattern of policy.autoApprove.bash.deny) {
      if (this.matchCommand(command, pattern)) {
        return { behavior: "deny", tier: 1, reason: `Command matches deny pattern: ${pattern}` };
      }
    }

    for (const pattern of policy.autoApprove.bash.allow) {
      if (this.matchCommand(command, pattern)) {
        return { behavior: "allow", tier: 1, reason: `Command matches allow pattern: ${pattern}` };
      }
    }

    return {
      behavior: "escalate",
      tier: 2,
      reason: `Bash command matches neither allow nor deny: ${command.slice(0, 80)}`,
    };
  }

  private matchCommand(command: string, pattern: string): boolean {
    if (pattern.endsWith(" *")) {
      const prefix = pattern.slice(0, -2);
      return command === prefix || command.startsWith(prefix + " ");
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      return command.startsWith(prefix);
    }
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return command.startsWith(prefix);
    }
    return command === pattern;
  }

  private matchesEscalateAlways(
    policy: AgentPolicy,
    toolName: string,
    input: Record<string, unknown>
  ): boolean {
    if (!["Edit", "Write", "Read"].includes(toolName)) return false;
    const filePath = (input.file_path as string) ?? "";
    for (const pattern of policy.escalateAlways) {
      if (filePath.endsWith(pattern) || minimatch(filePath, `**/${pattern}`)) {
        return true;
      }
    }
    return false;
  }

  buildCanUseTool(
    policy: AgentPolicy,
    onLog?: (agent: string, tool: string, input: string, tier: number, decision: string, decidedBy: string) => void,
    onEscalate?: (agent: string, tool: string, input: Record<string, unknown>, reason: string) => void
  ): (toolName: string, input: Record<string, unknown>) => Promise<
    { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }
  > {
    return async (toolName: string, input: Record<string, unknown>) => {
      const decision = this.evaluate(policy, toolName, input);

      const inputSummary =
        toolName === "Bash"
          ? (input.command as string)?.slice(0, 120) ?? ""
          : JSON.stringify(input).slice(0, 120);

      onLog?.(policy.codename, toolName, inputSummary, decision.tier, decision.behavior, "rule");

      if (decision.behavior === "allow") {
        return { behavior: "allow" as const, updatedInput: input };
      }

      if (decision.behavior === "deny") {
        return { behavior: "deny" as const, message: decision.reason };
      }

      onEscalate?.(policy.codename, toolName, input, decision.reason);
      return { behavior: "deny" as const, message: `Escalated: ${decision.reason}` };
    };
  }
}
