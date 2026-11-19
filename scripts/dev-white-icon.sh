#!/usr/bin/env bash
# Launch `pnpm dev` (white dock icon) from a real Terminal so it is not
# inherited from a Grok-agent sandbox.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_HOME="$ROOT/.cargo-home"
export CARGO_TARGET_DIR="$ROOT/src-tauri/target"
export PATH="$ROOT/node_modules/.bin:$PATH"
cd "$ROOT"
# --no-watch: cargo rebuilds of src-tauri would remount the splash in a loop.
exec pnpm dev -- --no-watch
