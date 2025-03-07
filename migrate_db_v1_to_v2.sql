-- Migration steps

-- Migrate users table

-- Create new table with pool_id
CREATE TABLE users_new (
    pool_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    health_factor REAL NOT NULL,
    collateral JSON NOT NULL,
    liabilities JSON,
    updated INTEGER NOT NULL,
    PRIMARY KEY (pool_id, user_id)
);

-- Copy data to new table with default pool_id
INSERT INTO users_new (
    pool_id, 
    user_id, 
    health_factor, 
    collateral, 
    liabilities, 
    updated
)
SELECT 
    'default_pool', 
    user_id, 
    health_factor, 
    collateral, 
    liabilities, 
    updated 
FROM users;

-- Drop old table
DROP TABLE users;

-- Rename new table
ALTER TABLE users_new RENAME TO users;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_health_factor ON users(health_factor);

-- Migrate auctions table
-- Check if pool_id column exists

-- Create new table with pool_id
CREATE TABLE auctions_new (
    pool_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    auction_type INTEGER NOT NULL,
    filler TEXT NOT NULL,
    start_block INTEGER NOT NULL,
    fill_block INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (pool_id, user_id, auction_type)
);

-- Copy data to new table with default pool_id
INSERT INTO auctions_new (
    pool_id, 
    user_id, 
    auction_type, 
    filler, 
    start_block, 
    fill_block, 
    updated
)
SELECT 
    'default_pool', 
    user_id, 
    auction_type, 
    filler, 
    start_block, 
    fill_block, 
    updated 
FROM auctions;

-- Drop old table
DROP TABLE auctions;

-- Rename new table
ALTER TABLE auctions_new RENAME TO auctions;

-- Migrate filled_auctions table
-- Check if pool_id column exists

-- Create new table with pool_id
CREATE TABLE filled_auctions_new (
    tx_hash TEXT PRIMARY KEY,
    pool_id TEXT NOT NULL,
    filler TEXT NOT NULL,
    user_id TEXT NOT NULL,
    auction_type INTEGER NOT NULL,
    bid JSON NOT NULL,
    bid_total REAL NOT NULL,
    lot JSON NOT NULL,
    lot_total REAL NOT NULL,
    est_profit REAL NOT NULL,
    fill_block INTEGER NOT NULL,
    timestamp INTEGER NOT NULL
);

-- Copy data to new table with default pool_id
INSERT INTO filled_auctions_new (
    tx_hash, 
    pool_id, 
    filler, 
    user_id, 
    auction_type, 
    bid, 
    bid_total, 
    lot, 
    lot_total, 
    est_profit, 
    fill_block, 
    timestamp
)
SELECT 
    tx_hash, 
    'default_pool', 
    filler, 
    user_id, 
    auction_type, 
    bid, 
    bid_total, 
    lot, 
    lot_total, 
    est_profit, 
    fill_block, 
    timestamp 
FROM filled_auctions;

-- Drop old table
DROP TABLE filled_auctions;

-- Rename new table
ALTER TABLE filled_auctions_new RENAME TO filled_auctions;

-- Recreate index
CREATE INDEX IF NOT EXISTS idx_filler ON filled_auctions(filler);

-- Update version information
INSERT INTO db_version (
    version, 
    description, 
    applied_at
) VALUES (
    2, 
    'Add pool_id column to users, auctions, and filled_auctions tables', 
    unixepoch()
);

