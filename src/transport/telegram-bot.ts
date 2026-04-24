import TelegramBot from "node-telegram-bot-api";
import type { TelegramButton } from "../engine/escalation-queue.js";

export type TelegramBotOptions = {
  botToken: string;
  chatId: string;
  onCommand: (command: string, args: string) => Promise<string>;
  onCallbackQuery: (action: string, escalationId: number) => Promise<string>;
  onFreeText: (text: string) => Promise<string>;
};

export class ConductorTelegramBot {
  private bot: TelegramBot;
  private chatId: string;
  private options: TelegramBotOptions;

  constructor(options: TelegramBotOptions) {
    this.options = options;
    this.chatId = options.chatId;
    this.bot = new TelegramBot(options.botToken, { polling: true });
    this.setupHandlers();
  }

  private setupHandlers() {
    this.bot.on("message", async (msg) => {
      if (String(msg.chat.id) !== this.chatId) return;
      const text = msg.text ?? "";

      if (text.startsWith("/")) {
        const [command, ...argParts] = text.split(" ");
        const args = argParts.join(" ");
        const response = await this.options.onCommand(command!, args);
        await this.bot.sendMessage(msg.chat.id, response, { parse_mode: "Markdown" });
      } else {
        const response = await this.options.onFreeText(text);
        await this.bot.sendMessage(msg.chat.id, response, { parse_mode: "Markdown" });
      }
    });

    this.bot.on("callback_query", async (callbackQuery) => {
      const msg = callbackQuery.message;
      if (!msg || String(msg.chat.id) !== this.chatId) return;
      const data = callbackQuery.data ?? "";
      const [action, idStr] = data.split(":");
      const escalationId = parseInt(idStr!, 10);

      const response = await this.options.onCallbackQuery(action!, escalationId);
      await this.bot.answerCallbackQuery(callbackQuery.id, { text: response });
      await this.bot.sendMessage(msg.chat.id, response);
    });
  }

  async sendMessage(text: string, buttons?: TelegramButton[][]) {
    const opts: TelegramBot.SendMessageOptions = { parse_mode: "Markdown" };

    if (buttons && buttons.length > 0) {
      opts.reply_markup = {
        inline_keyboard: buttons.map((row) =>
          row.map((btn) => ({ text: btn.text, callback_data: btn.callback_data }))
        ),
      };
    }

    await this.bot.sendMessage(this.chatId, text, opts);
  }

  stop() {
    this.bot.stopPolling();
  }
}
