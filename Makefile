# Pigeonhole: every command you need. `make` lists them.

SHELL := /bin/bash
# Without pipefail, `pg_dump | gzip` succeeds whenever gzip does, which is how
# a failed dump becomes an empty file that looks like a backup.
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

COMPOSE ?= docker compose
PSQL = $(COMPOSE) exec -T postgres psql -U pigeonhole -d pigeonhole

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# ── run ──────────────────────────────────────────────────────────────────────

.PHONY: init
init: ## Write .env with fresh secrets and your OpenRouter key (safe to re-run)
	@./scripts/init.sh

.PHONY: up
up: ## Build and start (writing .env on first run), then wait until healthy
	@test -f .env || ./scripts/init.sh
	$(COMPOSE) up -d --build --remove-orphans --wait
	@echo
	@echo "Pigeonhole is up: http://$$(grep -E '^PH_BIND=' .env | cut -d= -f2- || echo 127.0.0.1:8080)"
	@echo "Admin token:      $$(grep -E '^PH_ADMIN_TOKEN=' .env | cut -d= -f2-)"

.PHONY: down
down: ## Stop, keeping data
	$(COMPOSE) down

.PHONY: check
check: ## Database, migrations and a live model call; non-zero if anything is wrong
	@$(COMPOSE) exec -T app node dist/cli/index.js check

.PHONY: logs
logs: ## Follow logs
	$(COMPOSE) logs -f --tail=200

.PHONY: ps
ps: ## Show container status
	@$(COMPOSE) ps

.PHONY: psql
psql: ## Open psql on the database
	$(COMPOSE) exec postgres psql -U pigeonhole -d pigeonhole

.PHONY: reset
reset: ## Stop and DELETE the database volume
	@read -p "This deletes every pipeline and run. Type 'yes': " ok; [ "$$ok" = "yes" ] || { echo aborted; exit 1; }
	$(COMPOSE) down -v

# ── backups ──────────────────────────────────────────────────────────────────

.PHONY: backup
backup: ## Dump the database to backups/pigeonhole-<time>.sql.gz
	@mkdir -p backups && chmod 700 backups
	@umask 077; f="backups/pigeonhole-$$(date -u +%Y%m%dT%H%M%SZ).sql.gz"; \
	$(COMPOSE) exec -T postgres pg_dump -U pigeonhole -d pigeonhole --clean --if-exists | gzip > "$$f.partial"; \
	mv "$$f.partial" "$$f"; echo "$$f"

# The dump drops and recreates every table, in one transaction: if anything
# fails, nothing changes.
.PHONY: restore
restore: ## Replace the database with a backup: make restore FILE=backups/…sql.gz
	@test -f "$(FILE)" || { echo "usage: make restore FILE=backups/pigeonhole-….sql.gz"; exit 1; }
	@read -p "Replace the whole database with $(FILE)? Type 'restore': " ok; [ "$$ok" = restore ] || { echo aborted; exit 1; }
	$(COMPOSE) stop app
	gunzip -c "$(FILE)" | $(PSQL) -q --single-transaction -v ON_ERROR_STOP=1 >/dev/null
	$(COMPOSE) up -d --wait app
	@echo "restored $(FILE)"

# ── development ──────────────────────────────────────────────────────────────

.PHONY: test-db
test-db: ## Start a throwaway Postgres for the integration tests
	@docker inspect pigeonhole-test-db >/dev/null 2>&1 || \
	  docker run -d --name pigeonhole-test-db \
	    -e POSTGRES_DB=pigeonhole -e POSTGRES_USER=pigeonhole -e POSTGRES_PASSWORD=devpass \
	    -p 127.0.0.1:55432:5432 postgres:17-alpine >/dev/null
	@docker start pigeonhole-test-db >/dev/null
	@for i in $$(seq 1 30); do \
	  docker exec pigeonhole-test-db pg_isready -U pigeonhole -d pigeonhole >/dev/null 2>&1 && exit 0; \
	  sleep 1; \
	done; echo "test database did not become ready"; exit 1

.PHONY: test
test: test-db ## Typecheck, then run the unit and integration tests
	npm run typecheck
	DATABASE_URL=postgres://pigeonhole:devpass@localhost:55432/pigeonhole npm test

.PHONY: test-db-down
test-db-down: ## Remove the throwaway test database
	@docker rm -f pigeonhole-test-db >/dev/null 2>&1 || true
