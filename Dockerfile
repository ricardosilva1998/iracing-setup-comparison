FROM node:22-alpine AS base

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Build the app
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV DATABASE_PATH=/app/dev.db

RUN npx prisma generate && \
    npx prisma db push && \
    npx tsx lib/seed.ts && \
    npm run build

# Production runner
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Install Chromium for the Grid-and-Go scraper. Playwright's bundled
# chrome-headless-shell isn't available on Alpine (no apt/yum installer), so we
# use Alpine's packaged Chromium and tell Playwright to launch it via
# CHROMIUM_PATH. nss / freetype / harfbuzz / ca-certificates / ttf-freefont
# are required at runtime by Chromium itself.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# The baked seed DB ships at /app/dev.db.seed. At runtime, if DATABASE_PATH
# points at a volume location that doesn't yet have a DB, we copy the seed
# there so the first request finds an initialised schema.
COPY --from=builder /app/dev.db ./dev.db.seed

EXPOSE 3000

# Entrypoint: seed the volume-mounted DB on first boot, then start the server.
# Honours DATABASE_PATH (set by Railway runtime). Defaults to /app/dev.db when
# unset (matches the historical layout).
CMD sh -c '\
  set -e; \
  TARGET="${DATABASE_PATH:-/app/dev.db}"; \
  TARGET_DIR=$(dirname "$TARGET"); \
  mkdir -p "$TARGET_DIR"; \
  if [ ! -s "$TARGET" ]; then \
    echo "[boot] seeding $TARGET from /app/dev.db.seed (was missing or 0 bytes)"; \
    cp /app/dev.db.seed "$TARGET"; \
  else \
    echo "[boot] $TARGET already populated; preserving"; \
  fi; \
  exec node server.js'
