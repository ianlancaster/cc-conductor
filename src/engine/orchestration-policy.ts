import type { OrchestrationPolicy } from "../config.js";

export type OrchestrationVerb =
  | "start"
  | "stop"
  | "continue"
  | "setAutonomy"
  | "send";

export type PolicyCheck = { allowed: boolean; reason?: string };

/**
 * Blacklist-by-default policy gate. An agent can perform any orchestration
 * verb against any peer unless:
 *   (a) the agent targets itself (hardcoded deny, not policy-driven), or
 *   (b) the agent's orchestration policy lists the target under the matching
 *       deny_* list for the verb.
 *
 * Returns { allowed: true } when no restriction applies.
 */
export function checkOrchestrationPolicy(
  sender: string,
  verb: OrchestrationVerb,
  target: string,
  senderPolicy: OrchestrationPolicy | undefined
): PolicyCheck {
  if (sender === target) {
    return { allowed: false, reason: `${sender} cannot ${verb} itself` };
  }
  if (!senderPolicy) return { allowed: true };

  const denyList = denyListFor(senderPolicy, verb);
  if (denyList && denyList.includes(target)) {
    return {
      allowed: false,
      reason: `policy denies ${sender} → ${verb} → ${target}`,
    };
  }
  return { allowed: true };
}

function denyListFor(
  policy: OrchestrationPolicy,
  verb: OrchestrationVerb
): string[] | undefined {
  switch (verb) {
    case "start":
      return policy.denyStart;
    case "stop":
      return policy.denyStop;
    case "continue":
      return policy.denyContinue;
    case "setAutonomy":
      return policy.denySetAutonomy;
    case "send":
      return policy.denySend;
  }
}
