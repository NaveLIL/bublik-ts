#!/bin/sh
set -e

echo "applying db schema..."


npx prisma db push --skip-generate --accept-data-loss

echo "ok, starting bot"

exec node dist/index.js
