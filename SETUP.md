# Agent Conductor — Setup Guide

## 1. Telegram Bot Setup

1. Open Telegram on your phone
2. Search for `@BotFather` and start a conversation
3. Send `/newbot`
4. Choose a name (e.g., "Agent Conductor")
5. Choose a username (must end in `bot`, e.g., `my_conductor_bot`)
6. BotFather will reply with a **token** — copy it
7. Send a message to your new bot (just say "hello") — this creates the chat
8. Get your chat ID by visiting: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   - Find `"chat":{"id":` in the response — that number is your chat ID

## 2. Set Environment Variables

Create a `.env` file in the conductor directory:

```bash
CONDUCTOR_TELEGRAM_TOKEN="your-bot-token-from-botfather"
CONDUCTOR_TELEGRAM_CHAT_ID="your-chat-id-number"
```

## 3. Start Ollama (optional, for Tier 2 decisions)

```bash
ollama serve          # in a separate terminal
ollama pull qwen3:8b  # one-time model download (~5.5GB)
```

The conductor works without Ollama — it just escalates anything that would have gone to the local model.

## 4. Run the Conductor

Development mode (foreground):
```bash
cd agent-conductor
make start
```

Production mode (launchd daemon):
```bash
make build
make daemon-install
```

## 5. Verify

From Telegram, send `/status` to your bot. You should see:
```
No active sessions.
```

From terminal:
```bash
npx tsx src/cli.ts status
```

## 6. First Real Test

From Telegram:
```
/start my-project
```

This starts a Claude Code session for `my-project` (configured in `config/agents/my-project.yaml`).
