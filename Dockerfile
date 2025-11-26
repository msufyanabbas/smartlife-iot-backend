# Multi-stage build for optimized production image
FROM node:25-alpine AS builder

# Install build dependencies (required for native modules like bcrypt, snappy, etc.)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    libc-dev \
    linux-headers \
    git

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install ALL dependencies (including devDependencies for building)
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies to reduce size
RUN npm prune --production --legacy-peer-deps

# Production stage
FROM node:25-alpine

# Install runtime dependencies and utilities
RUN apk add --no-cache \
    tini \
    curl \
    dumb-init \
    ca-certificates \
    && apk upgrade --no-cache

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy built node_modules from builder (production only)
COPY --from=builder /app/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy necessary runtime files (migrations, seeds, configs)
COPY --from=builder /app/src/database ./src/database
COPY --from=builder /app/src/config ./src/config
COPY --from=builder /app/src/scripts ./src/scripts

# Copy TypeORM configuration for migrations
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Create necessary directories
RUN mkdir -p logs uploads backups

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:5000/health || exit 1

# Expose application port
EXPOSE 5000

# Use dumb-init to handle signals properly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start application
CMD ["node", "dist/main.js"]