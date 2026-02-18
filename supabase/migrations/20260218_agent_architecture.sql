-- Migration: Agent-Based Architecture
-- Adds learnings table, new customer fields, and new voice profile fields.

-- ─── New table: learnings ───
CREATE TABLE IF NOT EXISTS learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL,
  category TEXT NOT NULL,
  insight TEXT NOT NULL,
  confidence FLOAT DEFAULT 0.5,
  sample_size INTEGER DEFAULT 1,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learnings_channel_active
  ON learnings (channel_id, active)
  WHERE active = TRUE;

-- ─── Alter customers table ───
-- New onboarding fields (questions 2, 4-5, 10-11)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS icp_pain_points TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS buying_reasons TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cta_preference TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ad_platforms TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS mandatory_phrases_raw TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS banned_phrases_raw TEXT;

-- ─── Alter voice_profiles table ───
-- Enhanced profile fields from upgraded onboarding
ALTER TABLE voice_profiles ADD COLUMN IF NOT EXISTS audience_pain_points JSONB;
ALTER TABLE voice_profiles ADD COLUMN IF NOT EXISTS buying_triggers JSONB;
ALTER TABLE voice_profiles ADD COLUMN IF NOT EXISTS competitive_advantages JSONB;
ALTER TABLE voice_profiles ADD COLUMN IF NOT EXISTS platform_preferences JSONB;
