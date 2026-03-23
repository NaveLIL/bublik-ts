
FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app


COPY package.json package-lock.json* ./
RUN npm ci --omit=dev


COPY prisma ./prisma
RUN npx prisma generate


COPY dist-protected ./dist
COPY locales ./locales


COPY scripts/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD pgrep -f "node dist/index.js" > /dev/null || exit 1

ENV NODE_ENV=production

ENTRYPOINT ["./entrypoint.sh"]
