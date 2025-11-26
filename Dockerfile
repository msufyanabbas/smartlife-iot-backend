# Multi-stage build for optimized production image
FROM node:25-alpine AS builder

# Install build dependencies (required for native modules like bcrypt, snappy, etc.)
RUN apk add --no-cache python3 make g++ gcc libc-dev linux-headers

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies - use npm install if no lock file
RUN if [ -f package-lock.json ]; then \
        npm ci --legacy-peer-deps; \
    else \
        npm install --legacy-peer-deps; \
    fi

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove dev dependencies to reduce size
RUN npm prune --production --legacy-peer-deps

# Production stage
FROM node:25-alpine

# Install runtime dependencies and security updates
RUN apk add --no-cache \
    tini \
    curl \
    dumb-init \
    && apk upgrade --no-cache

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy node_modules from builder (already pruned to production only)
COPY --from=builder /app/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy necessary runtime files and directories
COPY --from=builder /app/src/database ./src/database
COPY --from=builder /app/src/config ./src/config
COPY --from=builder /app/src/scripts ./src/scripts

# Create directories for logs and uploads
RUN mkdir -p logs uploads

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Health check - using correct port 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Expose application port
EXPOSE 5000

# Use dumb-init to handle signals properly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start application
CMD ["node", "dist/main.js"]