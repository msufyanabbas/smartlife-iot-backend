#!/bin/bash

# Automated Database Backup Script for Smart Life IoT Platform
# This script creates PostgreSQL backups and manages retention

set -e

# Configuration
BACKUP_DIR="/var/www/smartlife-iot/backups"
COMPOSE_FILE="/var/www/smartlife-iot/docker-compose.prod.yml"
RETENTION_DAYS=7
MAX_BACKUPS=30

# Timestamp
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/auto-backup-${TIMESTAMP}.sql"
BACKUP_FILE_GZ="${BACKUP_FILE}.gz"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if backup directory exists
if [ ! -d "$BACKUP_DIR" ]; then
    log_info "Creating backup directory: $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
fi

# Check if database container is running
if ! docker compose -f "$COMPOSE_FILE" ps postgres | grep -q "Up"; then
    log_error "PostgreSQL container is not running!"
    exit 1
fi

log_info "Starting database backup..."

# Create backup
if docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U smartlife -d smartlife_iot --clean --if-exists > "$BACKUP_FILE" 2>/dev/null; then
    
    # Compress backup
    log_info "Compressing backup..."
    gzip "$BACKUP_FILE"
    
    # Get file size
    SIZE=$(du -h "$BACKUP_FILE_GZ" | cut -f1)
    log_info "Backup created successfully: ${BACKUP_FILE_GZ} (${SIZE})"
    
    # Calculate checksum
    CHECKSUM=$(sha256sum "$BACKUP_FILE_GZ" | cut -d' ' -f1)
    echo "$CHECKSUM" > "${BACKUP_FILE_GZ}.sha256"
    log_info "Checksum: $CHECKSUM"
else
    log_error "Backup failed!"
    rm -f "$BACKUP_FILE" 2>/dev/null
    exit 1
fi

# Cleanup old backups based on retention
log_info "Cleaning up old backups (keeping last $MAX_BACKUPS backups)..."
cd "$BACKUP_DIR"
ls -t auto-backup-*.sql.gz 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm -f
ls -t auto-backup-*.sql.gz.sha256 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm -f

# Delete backups older than retention days
find "$BACKUP_DIR" -name "auto-backup-*.sql.gz" -type f -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "auto-backup-*.sql.gz.sha256" -type f -mtime +$RETENTION_DAYS -delete

# Count remaining backups
BACKUP_COUNT=$(ls -1 auto-backup-*.sql.gz 2>/dev/null | wc -l)
log_info "Total backups: $BACKUP_COUNT"

# Calculate total backup size
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
log_info "Total backup size: $TOTAL_SIZE"

log_info "Backup completed successfully!"

# Optional: Send notification (uncomment if needed)
# curl -X POST https://your-webhook-url.com \
#   -H 'Content-Type: application/json' \
#   -d "{\"text\":\"✅ Database backup completed: ${BACKUP_FILE_GZ}\"}"

exit 0
