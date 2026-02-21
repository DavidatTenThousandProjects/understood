-- Migration: Agent Loop Copy Generation + Learning Mechanism Overhaul
-- New tables: copy_feedback, exemplars
-- Altered tables: learnings (merge support), generations (agent loop tracking)

-- ─── New table: copy_feedback ───
-- Structured feedback replacing raw "Copy feedback: ..." brand notes
CREATE TABLE IF NOT EXISTS copy_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  generation_id UUID REFERENCES generations(id),
  variant_number INTEGER, -- 1-4, NULL if applies to all
  action TEXT NOT NULL, -- approved / revised / rejected / clarification
  feedback_text TEXT,
  original_variant JSONB, -- snapshot before revision
  revised_variant JSONB, -- snapshot after revision (NULL if approved/rejected)
  approval_reason TEXT, -- WHY they liked it (captured via follow-up)
  slack_user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_copy_feedback_channel
  ON copy_feedback (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copy_feedback_generation
  ON copy_feedback (generation_id);

-- ─── New table: exemplars ───
-- Gold-standard approved copy for few-shot prompting
CREATE TABLE IF NOT EXISTS exemplars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  generation_id UUID REFERENCES generations(id),
  voice_profile_id UUID REFERENCES voice_profiles(id),
  variant JSONB NOT NULL, -- the approved CopyVariant
  source_type TEXT, -- video / image
  approval_reason TEXT,
  source_transcript_snippet TEXT, -- first 500 chars of source material
  score FLOAT DEFAULT 1.0, -- 1.0 = explicit approval, 0.8 = implicit
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exemplars_channel_active
  ON exemplars (channel_id, active, score DESC)
  WHERE active = TRUE;

-- ─── Alter learnings: merge-based accumulation ───
ALTER TABLE learnings ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES learnings(id);
ALTER TABLE learnings ADD COLUMN IF NOT EXISTS source_feedback_ids UUID[];
ALTER TABLE learnings ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE learnings ADD COLUMN IF NOT EXISTS last_reinforced_at TIMESTAMPTZ DEFAULT NOW();

-- ─── Alter generations: agent loop tracking ───
ALTER TABLE generations ADD COLUMN IF NOT EXISTS agent_turns INTEGER;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS agent_duration_ms INTEGER;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS quality_issues JSONB;
