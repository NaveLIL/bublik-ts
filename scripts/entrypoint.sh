#!/bin/sh
set -e

echo "╔════════════════════════════════════╗"
echo "║   Bublik Bot — Applying schema…    ║"
echo "╚════════════════════════════════════╝"

# Применяем схему Prisma к БД (создаёт/обновляет таблицы)
npx prisma db push --skip-generate

echo "✓ Database schema applied"
echo ""
echo "Starting Bublik Bot…"

exec node dist/index.js
