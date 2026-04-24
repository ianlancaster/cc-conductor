import type { AgentPolicy } from "../config.js";
import { existsSync } from "fs";
import { join } from "path";

export type MessageRouterOptions = {
  agents: Record<string, AgentPolicy>;
  startSession: (
    agent: string,
    prompt: string
  ) => Promise<{ sessionId: string; result: string; subtype: string }>;
  insertMessage: (params: { sender: string; recipient: string; type: string; content: string }) => void;
  markMessageResponded: (id: number, response: string) => void;
};

export class MessageRouter {
  private options: MessageRouterOptions;

  constructor(options: MessageRouterOptions) {
    this.options = options;
  }

  async routeConsultation(sender: string, recipient: string, message: string): Promise<string> {
    const senderPolicy = this.options.agents[sender];
    if (!senderPolicy || !senderPolicy.peerAccess.canConsult.includes(recipient)) {
      throw new Error(`${sender} cannot consult ${recipient} — not in canConsult list`);
    }

    const recipientPolicy = this.options.agents[recipient];
    if (!recipientPolicy) {
      throw new Error(`No policy found for recipient: ${recipient}`);
    }

    this.options.insertMessage({
      sender,
      recipient,
      type: "consultation",
      content: message,
    });

    const isCognitive = existsSync(join(recipientPolicy.repo, ".cognitive-agent"));
    const preamble = isCognitive
      ? "Start by running /caffeinate to load your cognitive state, then address the following:"
      : "Address the following:";

    const consultationPrompt = [
      `You have received a consultation request from ${sender}.`,
      "",
      preamble,
      "",
      message,
      "",
      `Provide a thorough response. ${sender} will receive your full reply.`,
    ].join("\n");

    const result = await this.options.startSession(recipient, consultationPrompt);

    return result.result;
  }
}
