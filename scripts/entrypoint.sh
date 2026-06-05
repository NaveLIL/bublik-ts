#!/bin/sh
set -e

echo "applying db schema..."

if [ "${PRISMA_FORCE_DB_PUSH:-false}" = "true" ]; then
	echo "PRISMA_FORCE_DB_PUSH=true, running prisma db push (unsafe for prod)"
	npx prisma db push --skip-generate
else
	# Prefer migrations in production, but keep backward compatibility
	# for existing databases that were initialized without migration history.
	if [ -d prisma/migrations ] && find prisma/migrations -mindepth 1 -maxdepth 1 -type d | grep -q .; then
		tmp_log="$(mktemp)"
		if npx prisma migrate deploy >"$tmp_log" 2>&1; then
			cat "$tmp_log"
			rm -f "$tmp_log"
		else
			cat "$tmp_log"
			if grep -q "P3005" "$tmp_log"; then
				echo "migration history is missing for non-empty schema, falling back to prisma db push"
				npx prisma db push --skip-generate
				rm -f "$tmp_log"
			else
				rm -f "$tmp_log"
				exit 1
			fi
		fi
	else
		echo "no prisma migrations found, falling back to prisma db push"
		npx prisma db push --skip-generate
	fi
fi

echo "ok, starting bot"

exec node dist/index.js
