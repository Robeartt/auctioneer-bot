#!/bin/bash

# Log versions of container
echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"
echo "SQLite version: $(sqlite3 --version)"

# Verify node configuration files are present
if ! test -f ./data/config.json; then
  echo "No config.json file found in /app/data. Aborting."
  exit 1
fi

echo "Env file found."

# Initialize the database
sqlite3 ./data/auctioneer.sqlite < ./init_db.sql

echo "Database initialized."

# Migrate to the latest database schema
./db-migrations/v2/v2-migration.sh

# Make a directory to store the logs at /app/data/logs if it does not exist
if ! test -d ./data/logs; then
  mkdir ./data/logs
  echo "Created logs directory."
fi

echo "Setup complete."

echo "Starting auctioneer..."

# Start the app
node ./lib/main.js