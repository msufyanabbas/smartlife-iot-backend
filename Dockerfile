# Multi-stage build optimized for layer caching
FROM node:25-alpine AS base

# Install ALL system dependencies once (cached layer)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    libc-dev \
    linux-headers \
    git \
    tini \
    curl \
    dumb-init \
    ca-certificates

WORKDIR /app

# ===========================
# Dependencies Stage
# ===========================
FROM base AS dependencies

# Copy ONLY package files (this layer is cached unless package.json changes)
COPY package*.json ./

# Install dependencies (this layer is cached unless package.json changes)
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# ===========================
# Builder Stage
# ===========================
FROM dependencies AS builder

# Copy TypeScript config
COPY tsconfig*.json ./

# Copy source code
COPY src ./src

# Build the application
RUN npm run build

# Remove dev dependencies
RUN npm prune --production --legacy-peer-deps

# ===========================
# Production Stage
# ===========================
FROM node:25-alpine AS production

# Install only runtime utilities
RUN apk add --no-cache \
    tini \
    curl \
    dumb-init \
    ca-certificates \
    && apk upgrade --no-cache

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy runtime files (migrations, seeds, configs)
COPY src/database ./src/database
COPY src/config ./src/config
COPY src/scripts ./src/scripts
COPY tsconfig.json ./tsconfig.json

# Create necessary directories
RUN mkdir -p logs uploads backups

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:5000/health || exit 1

EXPOSE 5000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/main.js"]