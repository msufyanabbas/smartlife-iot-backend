#!/bin/bash

# Database Restore Script for Smart Life IoT Platform
# Usage: ./restore.sh <backup-file.sql.gz>

set -e

# Configuration
COMPOSE_FILE="/var/www/smartlife-iot/docker-compose.prod.yml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check arguments
if [ $# -eq 0 ]; then
    log_error "Usage: $0 <backup-file.sql.gz>"
    echo ""
    echo "Available backups:"
    ls -lh /var/www/smartlife-iot/backups/*.sql.gz 2>/dev/null || echo "No backups found"
    exit 1
fi

BACKUP_FILE="$1"

# Check if backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
    log_error "Backup file not found: $BACKUP_FILE"
    exit 1
fi

# Check if checksum file exists and verify
if [ -f "${BACKUP_FILE}.sha256" ]; then
    log_info "Verifying backup integrity..."
    if sha256sum -c "${BACKUP_FILE}.sha256" 2>/dev/null; then
        log_info "Checksum verified ✓"
    else
        log_error "Checksum verification failed!"
        read -p "Continue anyway? (yes/no): " -r
        if [[ ! $REPLY =~ ^[Yy]es$ ]]; then
            exit 1
        fi
    fi
fi

# Confirm restore
log_warn "⚠️  WARNING: This will REPLACE the current database!"
log_warn "⚠️  Backup file: $BACKUP_FILE"
read -p "Are you sure you want to continue? (yes/no): " -r
if [[ ! $REPLY =~ ^[Yy]es$ ]]; then
    log_info "Restore cancelled"
    exit 0
fi

# Create a safety backup before restore
log_info "Creating safety backup of current database..."
SAFETY_BACKUP="/var/www/smartlife-iot/backups/pre-restore-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U smartlife -d smartlife_iot --clean --if-exists | gzip > "$SAFETY_BACKUP"
log_info "Safety backup created: $SAFETY_BACKUP"

# Decompress and restore
log_info "Restoring database from: $BACKUP_FILE"
gunzip -c "$BACKUP_FILE" | docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U smartlife -d smartlife_iot

if [ $? -eq 0 ]; then
    log_info "✅ Database restored successfully!"
    log_info "Safety backup is available at: $SAFETY_BACKUP"
else
    log_error "❌ Restore failed!"
    log_warn "Your data is safe. The safety backup is at: $SAFETY_BACKUP"
    exit 1
fi

exit 0
