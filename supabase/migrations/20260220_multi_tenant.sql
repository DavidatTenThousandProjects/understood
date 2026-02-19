-- Multi-tenant OAuth migration
-- Adds workspaces table and team_id to all existing tables

-- ─── New table: workspaces ───
CREATE TABLE IF NOT EXISTS workspaces (
  team_id TEXT PRIMARY KEY,
  team_name TEXT,
  bot_token TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  installed_by TEXT,
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  subscription_status TEXT DEFAULT 'trial',
  scope TEXT,
  is_active BOOLEAN DEFAULT TRUE
);

-- ─── Add team_id to all existing tables ───
ALTER TABLE customers ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE voice_profiles ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE brand_notes ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE learnings ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE processed_events ADD COLUMN IF NOT EXISTS team_id TEXT;

-- ─── Indexes ───
CREATE INDEX IF NOT EXISTS idx_customers_team ON customers (team_id);
CREATE INDEX IF NOT EXISTS idx_voice_profiles_team ON voice_profiles (team_id);
CREATE INDEX IF NOT EXISTS idx_generations_team ON generations (team_id);
CREATE INDEX IF NOT EXISTS idx_brand_notes_team ON brand_notes (team_id);
CREATE INDEX IF NOT EXISTS idx_learnings_team_active ON learnings (team_id, channel_id, active) WHERE active = TRUE;
