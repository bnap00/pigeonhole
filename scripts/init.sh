#!/usr/bin/env bash
# Writes .env from .env.sample: fresh secrets, plus your OpenRouter key.
# Safe to re-run: it never overwrites a value that is already set.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || cp .env.sample .env
chmod 600 .env

secret() { openssl rand -hex 24; }

# set_if_empty KEY VALUE: fills in KEY=, KEY=CHANGEME or a missing KEY, nothing else.
set_if_empty() {
  local key="$1" value="$2" current
  current="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  if [ -z "$current" ] || [ "$current" = "CHANGEME" ]; then
    if grep -qE "^${key}=" .env; then
      sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
    else
      echo "${key}=${value}" >> .env
    fi
    echo "  set ${key}"
  fi
}

set_if_empty PH_ADMIN_TOKEN "$(secret)"
set_if_empty POSTGRES_PASSWORD "$(secret)"

if ! grep -qE '^OPENROUTER_API_KEY=.+' .env; then
  key="${OPENROUTER_API_KEY:-}"
  if [ -z "$key" ] && [ -t 0 ]; then
    read -r -s -p "OpenRouter API key (https://openrouter.ai/keys): " key
    echo
  fi
  if [ -n "$key" ]; then
    set_if_empty OPENROUTER_API_KEY "$key"
  else
    echo "  OPENROUTER_API_KEY is empty: add it to .env before compiling or classifying"
  fi
fi

echo ".env is ready."
