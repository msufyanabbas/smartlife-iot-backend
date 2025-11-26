#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: ./generate-migration.sh MigrationName"
  exit 1
fi

npx typeorm migration:generate "src/database/migrations/$1" -d src/config/migration.config.ts


# chmod +x src/database/generate-migration.sh