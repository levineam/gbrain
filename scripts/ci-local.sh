#!/usr/bin/env bash
# scripts/ci-local.sh
#
# Local CI gate. Runs the same checks GH Actions does (and a bit more) inside
# a Docker container that bind-mounts this repo. See docker-compose.ci.yml.
#
# Modes:
#   bash scripts/ci-local.sh             # full local gate: gitleaks + unit + ALL E2E
#   bash scripts/ci-local.sh --diff      # full local gate: gitleaks + unit + selected E2E
#   bash scripts/ci-local.sh --no-pull   # skip docker compose pull (offline / debug)
#   bash scripts/ci-local.sh --clean     # nuke named volumes for cold debug
#
# Postgres runs on host port 5433 (see docker-compose.ci.yml). Named volumes
# `gbrain-ci-node-modules` and `gbrain-ci-bun-cache` keep the install warm.
#
# This is a STRONGER gate than current PR CI, not a "mirror." PR CI runs only
# Tier 1's 2 files; this runs all 29 (or the diff-selected subset). The intent
# is to catch what nightly Tier 1 catches before push.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="docker-compose.ci.yml"

DIFF=0
NO_PULL=0
CLEAN=0

for arg in "$@"; do
  case "$arg" in
    --diff) DIFF=1 ;;
    --no-pull) NO_PULL=1 ;;
    --clean) CLEAN=1 ;;
    *)
      echo "Usage: $0 [--diff] [--no-pull] [--clean]" >&2
      exit 1
      ;;
  esac
done

cleanup() {
  echo ""
  echo "[ci-local] Tearing down postgres..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>&1 | tail -5 || true
}
trap cleanup EXIT

if [ "$CLEAN" = "1" ]; then
  echo "[ci-local] --clean: removing named volumes..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>&1 | tail -5 || true
fi

# Pre-flight: postgres host port. Defaults to 5434 (5432 is manual
# gbrain-test-pg, 5433 is commonly held by sibling projects). Override with
# GBRAIN_CI_PG_PORT=NNNN bun run ci:local.
PG_PORT="${GBRAIN_CI_PG_PORT:-5434}"
PORT_OWNER=$(docker ps --filter "publish=$PG_PORT" --format "{{.Names}}" | head -1)
if [ -n "$PORT_OWNER" ]; then
  echo "[ci-local] ERROR: host port $PG_PORT is already used by docker container '$PORT_OWNER'." >&2
  echo "[ci-local] Either stop that container or run with: GBRAIN_CI_PG_PORT=5435 bun run ci:local" >&2
  exit 1
fi
if lsof -iTCP:"$PG_PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
  echo "[ci-local] ERROR: host port $PG_PORT is held by a non-docker process." >&2
  echo "[ci-local] Run with: GBRAIN_CI_PG_PORT=5435 bun run ci:local" >&2
  exit 1
fi
export GBRAIN_CI_PG_PORT="$PG_PORT"

# Step 0: gitleaks on the host (no docker, no postgres, no bun needed).
# Mirrors the structure of test.yml where gitleaks is a separate job from the
# test job. Fail loudly if not installed — it's a one-time setup step.
echo "[ci-local] gitleaks detect (host)..."
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[ci-local] ERROR: gitleaks not installed on host." >&2
  echo "[ci-local]   macOS:  brew install gitleaks" >&2
  echo "[ci-local]   Linux:  https://github.com/gitleaks/gitleaks/releases" >&2
  exit 1
fi
# Two scopes for pre-push:
#   1. Working-tree files (catch uncommitted secrets sitting in files)
#   2. Branch commits vs origin/master (catch secrets committed on this branch)
# Full-history scan is ~4 min on this repo's 3700+ commits and isn't useful
# pre-push (those secrets are already on master). CI's gitleaks job scans full
# history as the authoritative gate.
gitleaks dir . --redact --no-banner
gitleaks git . --redact --no-banner --log-opts="origin/master..HEAD"

# Step 1: pull. Refreshes both pgvector and oven/bun:1 because both are
# `image:` not `build:` (Codex F3 fix).
if [ "$NO_PULL" = "0" ]; then
  echo "[ci-local] Pulling base images (use --no-pull to skip)..."
  docker compose -f "$COMPOSE_FILE" pull 2>&1 | tail -5
fi

# Step 2: postgres up + wait for healthy.
echo "[ci-local] Starting postgres..."
docker compose -f "$COMPOSE_FILE" up -d postgres
echo "[ci-local] Waiting for postgres healthy..."
for i in {1..30}; do
  status=$(docker compose -f "$COMPOSE_FILE" ps --format json postgres 2>/dev/null | grep -o '"Health":"[^"]*"' | head -1 | sed 's/.*":"//;s/"//')
  if [ "$status" = "healthy" ]; then
    echo "[ci-local] Postgres healthy."
    break
  fi
  if [ "$i" = "30" ]; then
    echo "[ci-local] ERROR: postgres did not become healthy in 30 attempts" >&2
    exit 1
  fi
  sleep 1
done

# Step 3: smoke-test scripts/run-e2e.sh argv handling at startup. Catches typos
# before paying for a full run.
echo "[ci-local] Smoke: run-e2e.sh argv tweak..."
SMOKE_NO_ARGS=$(bash scripts/run-e2e.sh --dry-run-list | wc -l | tr -d ' ')
EXPECTED_ALL=$(ls test/e2e/*.test.ts | wc -l | tr -d ' ')
if [ "$SMOKE_NO_ARGS" != "$EXPECTED_ALL" ]; then
  echo "[ci-local] ERROR: --dry-run-list (no args) printed $SMOKE_NO_ARGS, expected $EXPECTED_ALL" >&2
  exit 1
fi
SMOKE_ONE_ARG=$(bash scripts/run-e2e.sh --dry-run-list test/e2e/sync.test.ts)
if [ "$SMOKE_ONE_ARG" != "test/e2e/sync.test.ts" ]; then
  echo "[ci-local] ERROR: --dry-run-list with 1 arg printed '$SMOKE_ONE_ARG'" >&2
  exit 1
fi
echo "[ci-local] Smoke OK ($SMOKE_NO_ARGS files via no-arg, 1 file via single-arg)."

# Step 4: build the runner-side command. Quoted-as-list so xargs/argv pass
# through cleanly.
RUN_E2E_CMD="bash scripts/run-e2e.sh"
if [ "$DIFF" = "1" ]; then
  RUN_E2E_CMD='SELECTED=$(bun run scripts/select-e2e.ts) && if [ -z "$SELECTED" ]; then echo "[ci-local] selector emitted nothing (doc-only diff); skipping E2E."; else echo "$SELECTED" | xargs bash scripts/run-e2e.sh; fi'
fi

INNER_CMD=$(cat <<'EOF'
set -euo pipefail
echo "[runner] bun version: $(bun --version)"
# oven/bun:1 omits git; many unit tests use mkdtemp + git init for fixtures.
# Install at startup; ~5s amortized per run. Cheaper than baking a Dockerfile.
if ! command -v git >/dev/null 2>&1; then
  echo "[runner] Installing git (debian apt)..."
  apt-get update -qq >/dev/null
  apt-get install -y -qq git ca-certificates >/dev/null
fi
if [ ! -d /app/node_modules ] || [ -z "$(ls -A /app/node_modules 2>/dev/null)" ]; then
  echo "[runner] First run (or --clean): bun install --frozen-lockfile"
  bun install --frozen-lockfile
fi
# Match GH Actions structure: unit job has NO DATABASE_URL (so test/e2e/*
# files skip via hasDatabase() at the top); E2E job sets DATABASE_URL and
# uses scripts/run-e2e.sh for sequential execution. Without unset here,
# e2e tests would run twice — once parallel-and-broken in unit phase,
# once sequentially in E2E phase.
echo "[runner] bun run test (unit only — DATABASE_URL unset)"
env -u DATABASE_URL bun run test
echo "[runner] E2E (sequential, DATABASE_URL set)"
__RUN_E2E__
EOF
)

INNER_CMD="${INNER_CMD//__RUN_E2E__/$RUN_E2E_CMD}"

echo "[ci-local] Running checks inside runner container..."
docker compose -f "$COMPOSE_FILE" run --rm runner bash -c "$INNER_CMD"

echo ""
echo "[ci-local] All checks passed."
