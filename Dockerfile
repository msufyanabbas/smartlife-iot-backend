# Multi-stage build optimized for layer caching
# Base: Debian Bookworm Slim (required for canvas native deps)
FROM node:25-bookworm-slim AS base

# Install ALL system dependencies once (cached layer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    # ── Build tools ───────────────────────────────────────────────────────
    python3 \
    make \
    g++ \
    gcc \
    git \
    curl \
    dumb-init \
    ca-certificates \
    pkg-config \
    # ── node-canvas native build dependencies ────────────────────────────
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    libfreetype6-dev \
    libfontconfig1-dev \
    # ── libredwg build dependencies (build from source) ──────────────────
    autoconf \
    automake \
    libtool \
    libpcre2-dev \
    swig \
    && rm -rf /var/lib/apt/lists/*

# ── Build libredwg from source → provides dwg2dxf binary ─────────────────
# libredwg is NOT in Debian Bookworm default repos, so we compile it.
RUN git clone --depth=1 --branch 0.12.5 https://github.com/LibreDWG/libredwg.git /tmp/libredwg \
    && cd /tmp/libredwg \
    && sh autogen.sh \
    && ./configure --disable-bindings --disable-python \
    && make -j$(nproc) \
    && make install \
    && ldconfig \
    && rm -rf /tmp/libredwg

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

# Remove dev dependencies but keep ts-node and tsconfig-paths for seeds
RUN npm prune --production --legacy-peer-deps && \
    npm install --legacy-peer-deps ts-node tsconfig-paths

# ===========================
# Production Stage
# ===========================
FROM node:25-bookworm-slim AS production

# Install only runtime libraries (no build tools needed here)
RUN apt-get update && apt-get install -y --no-install-recommends \
    # ── Runtime utilities ─────────────────────────────────────────────────
    curl \
    dumb-init \
    ca-certificates \
    # ── node-canvas runtime shared libraries ──────────────────────────────
    libcairo2 \
    libpango1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    libpixman-1-0 \
    libfreetype6 \
    libfontconfig1 \
    # ── libredwg runtime dependencies ────────────────────────────────────
    libpcre2-8-0 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy dwg2dxf binary + libredwg shared libs from base stage
COPY --from=base /usr/local/bin/dwg2dxf /usr/local/bin/dwg2dxf
COPY --from=base /usr/local/bin/dwgread /usr/local/bin/dwgread
COPY --from=base /usr/local/lib/libredwg* /usr/local/lib/
RUN ldconfig

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy production node_modules from builder (includes ts-node & tsconfig-paths)
COPY --from=builder /app/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy ALL source files for ts-node scripts
COPY src ./src
COPY tsconfig.json ./tsconfig.json

# Create necessary directories
RUN mkdir -p logs uploads backups

# Create non-root user (Debian syntax)
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/sh -m nodejs && \
    chown -R nodejs:nodejs /app

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:5000/health || exit 1

EXPOSE 5000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/main.js"]