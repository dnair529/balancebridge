# ---------- Build stage ----------
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN npm run build

# Prune dev dependencies for the runtime image.
RUN npm prune --omit=dev

# ---------- Runtime stage ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# curl for the HEALTHCHECK only.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY drizzle ./drizzle
COPY public ./public

# Non-root user; uploads dir owned by it (mount a volume here in prod).
RUN useradd --system --create-home --shell /usr/sbin/nologin portal \
  && mkdir -p /data/uploads \
  && chown -R portal:portal /data /app
USER portal

ENV UPLOADS_DIR=/data/uploads
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

# Migrations run on boot, then the server starts.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
