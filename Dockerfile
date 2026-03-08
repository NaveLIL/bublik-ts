# ── Stage 1: Build ────────────────────────────
FROM node:20-alpine AS builder

RUN apk add --no-cache openssl openssl-dev

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npx prisma generate
RUN npm run build

# ── Stage 2: Production ──────────────────────
FROM node:20-alpine AS production

RUN apk add --no-cache openssl

WORKDIR /app

# Копируем только production-зависимости
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

# Копируем скомпилированный код и локали
COPY --from=builder /app/dist ./dist
COPY locales ./locales

# Применяем миграции БД при сборке (схема)
# Реальный push произойдёт в entrypoint
COPY scripts/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Здоровье контейнера
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD pgrep -f "node dist/index.js" > /dev/null || exit 1

ENV NODE_ENV=production

ENTRYPOINT ["./entrypoint.sh"]
