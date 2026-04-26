#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

GOAL=${1:-"build a first project workspace"}
BASE_URL=${BASE_URL:-"http://127.0.0.1:43123"}
WORKSPACE=${WORKSPACE:-"$REPO_ROOT/tmp/project-builder-workspace"}

cd "$REPO_ROOT"
exec pnpm agent-workspace -- init --goal "$GOAL" --base-url "$BASE_URL" --workspace "$WORKSPACE"
