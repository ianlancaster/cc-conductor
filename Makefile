SHELL := /bin/bash
.DEFAULT_GOAL := help

ifneq (,$(wildcard .env))
  include .env
  export
endif

TSX := npx tsx
LABEL := com.agent-conductor.local
PLIST_DST := $(HOME)/Library/LaunchAgents/$(LABEL).plist

# ─── Core ───────────────────────────────────────────────

.PHONY: start
start: data ## Start the conductor (foreground)
	$(TSX) src/index.ts

.PHONY: start-all
start-all: data ## Start conductor + open panes for all agents
	$(TSX) src/index.ts --start-all

.PHONY: focus
focus: ## Bring the iTerm2 conductor window to the foreground
	$(TSX) src/cli.ts focus

.PHONY: build
build: ## Compile TypeScript
	npx tsc

.PHONY: test
test: ## Run all tests
	npx vitest run

.PHONY: typecheck
typecheck: ## Type-check without building
	npx tsc --noEmit

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf dist

# ─── Agent Management ──────────────────────────────────

.PHONY: status
status: ## Show agent status
	$(TSX) src/cli.ts status

.PHONY: queue
queue: ## Show pending escalations
	$(TSX) src/cli.ts queue

.PHONY: logs
logs: ## Show recent health events
	$(TSX) src/cli.ts logs

# ─── Mode Switching ────────────────────────────────────

.PHONY: mode-desktop
mode-desktop: ## Switch to desktop transport
	@echo "Send /mode desktop via Telegram, or restart with TRANSPORT=desktop"

.PHONY: mode-remote
mode-remote: ## Switch to remote transport
	@echo "Send /mode remote via Telegram, or restart with TRANSPORT=remote"

# ─── Logs ───────────────────────────────────────────────

.PHONY: logs-conductor
logs-conductor: ## Tail the conductor log file
	tail -100f data/conductor.log

.PHONY: logs-conductor-errors
logs-conductor-errors: ## Show only warnings and errors
	grep -E "WARN |ERROR" data/conductor.log | tail -50

# ─── Daemon ─────────────────────────────────────────────

.PHONY: daemon-install
daemon-install: build ## Generate plist and install launchd daemon
	$(TSX) src/cli.ts daemon install
	launchctl bootstrap gui/$$(id -u) $(PLIST_DST)
	@echo "Daemon installed. Logs: /tmp/agent-conductor.stdout.log"

.PHONY: daemon-uninstall
daemon-uninstall: ## Stop and remove daemon
	-launchctl bootout gui/$$(id -u)/$(LABEL)
	rm -f $(PLIST_DST)
	@echo "Daemon removed."

.PHONY: daemon-restart
daemon-restart: ## Restart daemon
	-launchctl bootout gui/$$(id -u)/$(LABEL)
	launchctl bootstrap gui/$$(id -u) $(PLIST_DST)

.PHONY: daemon-status
daemon-status: ## Check daemon status
	@launchctl print gui/$$(id -u)/$(LABEL) 2>/dev/null && echo "Running" || echo "Not running"

.PHONY: daemon-logs
daemon-logs: ## Tail daemon logs
	@echo "=== stdout ===" && tail -50 /tmp/agent-conductor.stdout.log 2>/dev/null; \
	echo "=== stderr ===" && tail -50 /tmp/agent-conductor.stderr.log 2>/dev/null

# ─── Infrastructure ────────────────────────────────────

.PHONY: ollama-status
ollama-status: ## Check Ollama status
	@curl -s http://localhost:11434/api/tags | python3 -c "import sys,json; tags=json.load(sys.stdin); models=[m['name'] for m in tags.get('models',[])]; print('Models:', ', '.join(models) if models else 'none')" 2>/dev/null || echo "Ollama not running"

.PHONY: ollama-pull
ollama-pull: ## Pull the local model
	ollama pull qwen3:8b

.PHONY: telegram-test
telegram-test: ## Send a test message
	@curl -s -X POST "https://api.telegram.org/bot$(CONDUCTOR_TELEGRAM_TOKEN)/sendMessage" \
		-H "Content-Type: application/json" \
		-d '{"chat_id": $(CONDUCTOR_TELEGRAM_CHAT_ID), "text": "🟢 Test from Agent Conductor"}' \
		| python3 -c "import sys,json; r=json.load(sys.stdin); print('Sent' if r.get('ok') else 'Failed')"

# ─── Setup ──────────────────────────────────────────────

data:
	@mkdir -p data

.PHONY: setup
setup: data ## First-time setup
	npm install
	@echo ""
	@[ -f .env ] && echo "✓ .env" || echo "✗ .env missing"
	@[ -n "$(CONDUCTOR_TELEGRAM_TOKEN)" ] && echo "✓ Telegram token" || echo "✗ Telegram token not set"
	@[ -n "$(CONDUCTOR_TELEGRAM_CHAT_ID)" ] && echo "✓ Telegram chat ID" || echo "✗ Telegram chat ID not set"
	@[ -d "/Applications/iTerm.app" ] && echo "✓ iTerm2" || echo "✗ iTerm2 not installed"
	@curl -s http://localhost:11434/api/tags >/dev/null 2>&1 && echo "✓ Ollama" || echo "○ Ollama not running"
	@echo ""
	@echo "Ready. Run 'make start' to launch."

# ─── Help ───────────────────────────────────────────────

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
