#!/bin/sh
set -e

echo "applying db schema..."

if [ "${PRISMA_FORCE_DB_PUSH:-false}" = "true" ]; then
	echo "PRISMA_FORCE_DB_PUSH=true, running prisma db push (unsafe for prod)"
	npx prisma db push --skip-generate
else
	npx prisma migrate deploy
fi

echo "ok, starting bot"

exec node dist/index.js
