# ===========================
# Base Stage
# ===========================
FROM node:20-alpine AS base

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    libc-dev \
    linux-headers \
    dumb-init \
    curl \
    ca-certificates

WORKDIR /app

# ===========================
# Dependencies Stage
# ===========================
FROM base AS dependencies

COPY package*.json ./
RUN npm ci --legacy-peer-deps

# ===========================
# Builder Stage
# ===========================
FROM dependencies AS builder

COPY tsconfig*.json ./
COPY src ./src

RUN npm run build

# ===========================
# Production Dependencies
# ===========================
FROM base AS prod-deps

COPY package*.json ./

# Install production deps + ts-node/tsconfig-paths for seeders/migrations
RUN npm ci --legacy-peer-deps --omit=dev && \
    npm install --legacy-peer-deps --no-save ts-node tsconfig-paths

# ===========================
# Production Stage
# ===========================
FROM node:20-alpine AS production

RUN apk add --no-cache \
    dumb-init \
    curl \
    ca-certificates \
    && apk upgrade --no-cache

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Copy production node_modules (with ts-node for seeds/migrations)
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy compiled output only — no raw source in prod
COPY --from=builder /app/dist ./dist

# Copy ONLY src/database for ts-node scripts (seeds, migrations)
# Remove this line if you run migrations from dist/
COPY src/database ./src/database

RUN mkdir -p logs uploads backups

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:5000/health || exit 1

EXPOSE 5000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/main.js"]