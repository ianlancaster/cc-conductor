import TelegramBot from "node-telegram-bot-api";
import type { TelegramButton } from "../engine/escalation-queue.js";
import { log } from "../logger.js";

export type TelegramConfig = {
  botToken: string;
  chatId: string;
};

export type TelegramHandlers = {
  onCommand: (command: string, args: string) => Promise<string>;
  onAgentMessage: (agent: string, text: string) => Promise<void>;
  onFreeText: (text: string) => Promise<string | null>;
};

export class TelegramTransport {
  private bot: TelegramBot;
  private chatId: string;
  private handlers: TelegramHandlers;

  constructor(config: TelegramConfig, handlers: TelegramHandlers) {
    this.chatId = config.chatId;
    this.handlers = handlers;
    this.bot = new TelegramBot(config.botToken, { polling: true });
    this.setupHandlers();
  }

  private setupHandlers() {
    this.bot.on("message", async (msg) => {
      if (String(msg.chat.id) !== this.chatId) return;
      const text = msg.text ?? "";

      try {
        // `//cmd …` is the pass-through escape: route to the active /talk
        // target as free text with one leading slash stripped. This lets the operator
        // send agent-level slash commands (/caffeinate, /sleep, /status) via
        // Telegram without the bot intercepting them as its own commands.
        if (text.startsWith("//")) {
          const passthrough = text.slice(1);
          const response = await this.handlers.onFreeText(passthrough);
          if (response) {
            log().debug("telegram", `Responding to passthrough (${response.length} chars)`);
            await this.send(response);
          }
          return;
        }

        if (text.startsWith("/")) {
          const spaceIdx = text.indexOf(" ");
          const command = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
          const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);
          const response = await this.handlers.onCommand(command, args);
          if (response) {
            log().debug("telegram", `Responding to ${command} (${response.length} chars)`);
            await this.send(response);
            log().debug("telegram", `Response to ${command} sent`);
          } else {
            log().debug("telegram", `${command} returned empty response — nothing to send`);
          }
        } else {
          const response = await this.handlers.onFreeText(text);
          if (response) {
            await this.send(response);
          }
        }
      } catch (err) {
        log().error("telegram", `Message handler threw: ${String(err)}`);
      }
    });

    this.bot.on("callback_query", async (callbackQuery) => {
      const msg = callbackQuery.message;
      if (!msg || String(msg.chat.id) !== this.chatId) return;
      const data = callbackQuery.data ?? "";
      const [action, idStr] = data.split(":");

      const response = await this.handlers.onCommand(`/_callback_${action}`, idStr ?? "");
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: response.slice(0, 200) });
      await this.send(response);
    });
  }

  async send(text: string, buttons?: TelegramButton[][]): Promise<void> {
    if (!text.trim()) return;

    const maxLen = 4096;
    const chunks = this.splitMessage(text, maxLen);

    for (let i = 0; i < chunks.length; i++) {
      const opts: TelegramBot.SendMessageOptions = { parse_mode: "Markdown" };

      if (buttons && buttons.length > 0 && i === chunks.length - 1) {
        opts.reply_markup = {
          inline_keyboard: buttons.map((row) =>
            row.map((btn) => ({ text: btn.text, callback_data: btn.callback_data }))
          ),
        };
      }

      try {
        await this.bot.sendMessage(this.chatId, chunks[i]!, opts);
      } catch (err) {
        log().warn("telegram", `Markdown send failed, retrying as plain text: ${String(err).slice(0, 200)}`);
        try {
          await this.bot.sendMessage(this.chatId, chunks[i]!);
        } catch (err2) {
          log().error("telegram", `Plain-text send also failed: ${String(err2).slice(0, 200)}`);
          throw err2;
        }
      }
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
      let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
      if (splitIdx === -1 || splitIdx < maxLen / 2) {
        splitIdx = remaining.lastIndexOf("\n", maxLen);
      }
      if (splitIdx === -1 || splitIdx < maxLen / 2) {
        splitIdx = maxLen;
      }
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
  }

  stop(): void {
    this.bot.stopPolling();
  }
}
