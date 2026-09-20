#!/bin/bash
# Build dsh-research-team: compile src/ → lib/ (tsc, typecheck + declarations),
# bundle the browser client (tsdown), and copy prompt assets.
# Dependency resolution strategy (this machine):
#   @deepseek-ai/* type packages come from the web profile's node_modules
#   (which itself falls back to ~/.dsh/profiles/node_modules); react and
#   typescript/tsdown come from the sibling session-vault plugin's pnpm store.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DSH_GLOBAL="${DSH_GLOBAL:-$HOME/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules}"
PROFILE_NM="${PROFILE_NM:-$HOME/.dsh/profiles/web/node_modules}"
VAULT_NM="${VAULT_NM:-$HOME/dsh-plugins/dsh-session-vault/node_modules}"

if [ ! -d "$PROFILE_NM/@deepseek-ai/dsh-tools" ]; then
  echo "build: cannot find profile node_modules at $PROFILE_NM (set PROFILE_NM)" >&2
  exit 1
fi

link_pkg() {
  local link="node_modules/$1"
  local target="$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  rm -rf "$link"
  mkdir -p "$(dirname "$link")"
  ln -sfn "$(cd "$target" && pwd)" "$link"
}

echo "=== Linking build dependencies (profile: $PROFILE_NM) ==="
# Host-side type packages — resolve exactly as the runtime does at load time.
# cordis is type-only in our source (erased at compile time), so its instance
# identity does not matter; it comes from the dsh installation's own closure.
link_pkg @deepseek-ai/cordis                    "$DSH_GLOBAL/@deepseek-ai/cordis"
link_pkg @deepseek-ai/schemastery               "$PROFILE_NM/@deepseek-ai/schemastery"
link_pkg @deepseek-ai/dsh-tools                 "$PROFILE_NM/@deepseek-ai/dsh-tools"
link_pkg @deepseek-ai/dsh-subagent              "$PROFILE_NM/@deepseek-ai/dsh-subagent"
link_pkg @deepseek-ai/dsh-llm                   "$PROFILE_NM/@deepseek-ai/dsh-llm"
# Client-side type packages.
link_pkg @deepseek-ai/dsh-client-runtime        "$PROFILE_NM/@deepseek-ai/dsh-client-runtime"
link_pkg @deepseek-ai/dsh-client-ui-slots       "$PROFILE_NM/@deepseek-ai/dsh-client-ui-slots"
link_pkg @deepseek-ai/dsh-client-ui-settings    "$PROFILE_NM/@deepseek-ai/dsh-client-ui-settings"
# react + node types (from the sibling vault plugin's pnpm store).
VAULT_PNPM="$VAULT_NM/.pnpm"
link_pkg react                                  "$VAULT_PNPM/react@18.3.1/node_modules/react"
link_pkg @types/react                           "$VAULT_PNPM/@types+react@18.3.31/node_modules/@types/react"
link_pkg csstype                                "$VAULT_PNPM/csstype@3.2.3/node_modules/csstype"
link_pkg @types/node                            "$DSH_GLOBAL/@types/node"

echo "=== Compiling src → lib (tsc) ==="
TSC="$VAULT_NM/typescript/bin/tsc"
if [ ! -f "$TSC" ]; then
  echo "build: tsc not found at $TSC (set VAULT_NM)" >&2
  exit 1
fi
node "$TSC" -p tsconfig.json

echo "=== Bundling browser client (tsdown) ==="
TSDOWN="$VAULT_NM/.bin/tsdown"
if [ ! -f "$TSDOWN" ]; then
  echo "build: tsdown not found at $TSDOWN (set VAULT_NM)" >&2
  exit 1
fi
"$TSDOWN" --config tsdown.config.ts

echo "=== Copying prompt assets ==="
mkdir -p lib/prompts
cp src/prompts/*.md lib/prompts/

# tsc also emits the raw ESM client (lib/client/index.js); the package exports
# only the tsdown browser bundle (lib/client.js), so drop the duplicate.
rm -rf lib/client

echo "=== Build complete ==="
