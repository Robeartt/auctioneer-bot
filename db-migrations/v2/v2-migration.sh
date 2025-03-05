#!/bin/bash

# Set variables
DB_PATH="./data/auctioneer.sqlite"
MIGRATION_SCRIPT="./db-migrations/v2/migrate_db_v1_to_v2.sql"

# Check if sqlite3 is installed
if ! command -v sqlite3 &> /dev/null; then
    echo "Error: sqlite3 is not installed. Please install SQLite3."
    exit 1
fi

# Check if database file exists
if ! test -f $DB_PATH; then
    echo "Error: Database file $DB_PATH does not exist."
    exit 1
fi

# Check if migration script exists
if [ ! -f "$MIGRATION_SCRIPT" ]; then
    echo "Error: Migration script $MIGRATION_SCRIPT does not exist."
    exit 1
fi

# Function to get current database version
get_current_version() {
    sqlite3 "$DB_PATH" "
        CREATE TABLE IF NOT EXISTS db_version (
            version INTEGER PRIMARY KEY NOT NULL,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
        SELECT COALESCE(MAX(version), 0) FROM db_version;
    "
}

# Get current version
CURRENT_VERSION=$(get_current_version)

# Check if migration should be applied
if [ "$CURRENT_VERSION" -lt 2 ]; then
    echo "Applying migration to version 2..."
    
    # Run the migration script
    sqlite3 "$DB_PATH" < "$MIGRATION_SCRIPT"
    
    # Check if migration was successful
    if [ $? -eq 0 ]; then
        echo "Migration to version 2 completed successfully."
    else
        echo "Error: Migration failed."
        exit 1
    fi
fi