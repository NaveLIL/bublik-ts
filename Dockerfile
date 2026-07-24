FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

RUN apk add --no-cache openssl=3.5.7-r0 \
  && rm -f /var/log/apk.log

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund \
  && rm -rf /root/.npm /root/.cache /tmp/node-compile-cache

COPY prisma ./prisma
RUN ./node_modules/.bin/prisma generate \
  && rm -rf /root/.npm /root/.cache /tmp/node-compile-cache

COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY scripts/clean-build.js scripts/obfuscate.js scripts/verify-protected-artifact.js ./scripts/
RUN npm run build:protected \
  && rm -rf /root/.npm /root/.cache /tmp/node-compile-cache


FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime

RUN apk add --no-cache openssl=3.5.7-r0 \
  && rm -f /var/log/apk.log

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && rm -rf /root/.npm /root/.cache /tmp/node-compile-cache

COPY prisma ./prisma
RUN ./node_modules/.bin/prisma generate \
  && rm -rf /root/.npm /root/.cache /tmp/node-compile-cache

COPY --from=builder /app/dist-protected ./dist
COPY locales ./locales
COPY scripts/entrypoint.sh ./entrypoint.sh
COPY scripts/verify-baseline-target.js ./scripts/verify-baseline-target.js
COPY scripts/snapshot-baseline-data.js ./scripts/snapshot-baseline-data.js
COPY scripts/snapshot-redis-data.js ./scripts/snapshot-redis-data.js
COPY scripts/verify-pb-idle.js ./scripts/verify-pb-idle.js
RUN chmod +x ./entrypoint.sh \
  && mkdir -p /app/logs \
  && chown node:node /app/logs \
  && chmod 0750 /app/logs

ENV NODE_ENV=production \
  BUBLIK_HEALTH_FILE=/tmp/bublik-health.json \
  BUBLIK_HEALTH_MAX_AGE_MS=75000

ARG BUBLIK_RELEASE_REVISION=""
ARG BUBLIK_RELEASE_CREATED=""
ARG BUBLIK_RELEASE_VERSION=""
ARG BUBLIK_RELEASE_SOURCE=""
ARG BUBLIK_RELEASE_SOURCE_TREE=""
ARG BUBLIK_RELEASE_BASE_COMMIT=""

LABEL org.opencontainers.image.revision="${BUBLIK_RELEASE_REVISION}" \
  org.opencontainers.image.created="${BUBLIK_RELEASE_CREATED}" \
  org.opencontainers.image.version="${BUBLIK_RELEASE_VERSION}" \
  org.opencontainers.image.source="${BUBLIK_RELEASE_SOURCE}" \
  org.opencontainers.image.base.name="docker.io/library/node:24-alpine" \
  org.opencontainers.image.base.digest="sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd" \
  io.bublik.release.source-tree="${BUBLIK_RELEASE_SOURCE_TREE}" \
  io.bublik.release.base-commit="${BUBLIK_RELEASE_BASE_COMMIT}" \
  io.bublik.build.obfuscator-seed="1112883788"

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "dist/core/HealthMarker.js", "--check"]

USER node

ENTRYPOINT ["./entrypoint.sh"]
