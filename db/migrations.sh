#!/bin/bash

# Set variables
DB_PATH="./data/auctioneer.sqlite"
MIGRATION_SCRIPT="./db/migrate_db_v1_to_v2.sql"

PREV_POOL_ID=""

# Function to display usage information
show_usage() {
    echo "Usage: $0 [options]"
    echo "Options:"
    echo "  -h, --help                   Show this help message"
    echo "  -p, --prev-pool-id ID        Previous pool ID (required for v2 migration)"
}
# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_usage
            exit 0
            ;;
        -p|--prev-pool-id)
            if [ -z "$2" ]; then
                shift
            fi
            PREV_POOL_ID="$2"
            shift 2
            ;;
        *)
            echo "Error: Unknown option $1"
            show_usage
            exit 1
            ;;
    esac
done

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
  # Check if previous pool ID is provided for v2 migration
    if [ -z "$PREV_POOL_ID" ]; then
        echo "Error: Previous pool ID is required for v2 migration."
        echo "Please provide it using the -p or --prev-pool-id option."
        exit 1
    fi
    echo "Applying migration to version 2..."

 # First run the migration script to create the new tables
    sqlite3 "$DB_PATH" < "$MIGRATION_SCRIPT"
    MIGRATION_RESULT=$?
    
    # Check if migration was successful
    if [ $MIGRATION_RESULT -eq 0 ]; then
        echo "Migration to version 2 completed successfully."
    
        # Update the pool_id in all tables
        echo "Updating pool_id to '$PREV_POOL_ID' in all tables..."
        
        sqlite3 "$DB_PATH" "
            UPDATE users SET pool_id = '$PREV_POOL_ID' WHERE pool_id = 'default_pool';
            UPDATE auctions SET pool_id = '$PREV_POOL_ID' WHERE pool_id = 'default_pool';
            UPDATE filled_auctions SET pool_id = '$PREV_POOL_ID' WHERE pool_id = 'default_pool';
        " 

        # Check if migration was successful
        if [ $? -eq 0 ]; then
            echo "Successfully updated pool id to $PREV_POOL_ID."
        else
            echo "Error: Failed to update pool id."
            exit 1
        fi
    fi
fi
