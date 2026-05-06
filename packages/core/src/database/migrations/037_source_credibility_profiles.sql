CREATE TABLE IF NOT EXISTS source_credibility_profiles (
  profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'other',
  profile_author TEXT NOT NULL DEFAULT 'llm_auto',
  last_reviewed TIMESTAMPTZ,
  review_status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_credibility_profiles_source_unique UNIQUE (source_id),
  CONSTRAINT source_credibility_profiles_source_name_required_check CHECK (length(trim(source_name)) > 0),
  CONSTRAINT source_credibility_profiles_source_type_check CHECK (
    source_type IN ('government', 'academic', 'journalist', 'witness', 'organization', 'anonymous', 'other')
  ),
  CONSTRAINT source_credibility_profiles_author_check CHECK (profile_author IN ('llm_auto', 'human', 'hybrid')),
  CONSTRAINT source_credibility_profiles_review_status_check CHECK (review_status IN ('draft', 'reviewed', 'contested'))
);

CREATE TABLE IF NOT EXISTS credibility_dimensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES source_credibility_profiles(profile_id) ON DELETE CASCADE,
  dimension_id TEXT NOT NULL,
  label TEXT NOT NULL,
  score NUMERIC(4,3) NOT NULL,
  rationale TEXT NOT NULL,
  evidence_refs TEXT[] NOT NULL DEFAULT '{}',
  known_factors TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credibility_dimensions_profile_dimension_unique UNIQUE (profile_id, dimension_id),
  CONSTRAINT credibility_dimensions_dimension_id_required_check CHECK (length(trim(dimension_id)) > 0),
  CONSTRAINT credibility_dimensions_label_required_check CHECK (length(trim(label)) > 0),
  CONSTRAINT credibility_dimensions_score_bounds_check CHECK (score >= 0 AND score <= 1),
  CONSTRAINT credibility_dimensions_rationale_required_check CHECK (length(trim(rationale)) > 0),
  CONSTRAINT credibility_dimensions_evidence_refs_array_check CHECK (evidence_refs IS NOT NULL),
  CONSTRAINT credibility_dimensions_known_factors_array_check CHECK (known_factors IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_source_credibility_profiles_source
  ON source_credibility_profiles(source_id);
CREATE INDEX IF NOT EXISTS idx_source_credibility_profiles_review_status
  ON source_credibility_profiles(review_status);
CREATE INDEX IF NOT EXISTS idx_source_credibility_profiles_source_type
  ON source_credibility_profiles(source_type);
CREATE INDEX IF NOT EXISTS idx_credibility_dimensions_dimension_id
  ON credibility_dimensions(dimension_id);
CREATE INDEX IF NOT EXISTS idx_credibility_dimensions_low_score_review
  ON credibility_dimensions(score ASC, profile_id)
  WHERE score < 0.4;
