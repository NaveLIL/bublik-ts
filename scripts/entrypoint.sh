#!/bin/sh
set -e

baseline_mode="${PRISMA_BASELINE_EXISTING-0}"
migrate_only="${MIGRATE_ONLY-0}"

case "$baseline_mode" in
  0|1) ;;
  *)
    echo "invalid PRISMA_BASELINE_EXISTING flag; expected 0 or 1" >&2
    exit 1
    ;;
esac

case "$migrate_only" in
  0|1) ;;
  *)
    echo "invalid MIGRATE_ONLY flag; expected 0 or 1" >&2
    exit 1
    ;;
esac

prisma_cli="./node_modules/.bin/prisma"
if [ ! -x "$prisma_cli" ]; then
  echo "vendored Prisma CLI is unavailable" >&2
  exit 1
fi

echo "applying db schema..."

if [ "$baseline_mode" = "1" ]; then
  echo "verifying legacy database before one-time migration baseline..."
  baseline_state="$(node ./scripts/verify-baseline-target.js)"
  case "$baseline_state" in
    needs-resolve)
      "$prisma_cli" migrate resolve --applied 20260719000000_baseline
      ;;
    already-applied|fresh)
      ;;
    *)
      echo "unexpected baseline verifier result: $baseline_state" >&2
      exit 1
      ;;
  esac
fi

"$prisma_cli" migrate deploy

if [ "$migrate_only" = "1" ]; then
  echo "database migration completed; migration-only mode requested"
  exit 0
fi

echo "ok, starting bot"

exec node dist/index.js
