-- Browser-safe session auth for the API demo and V1 web app.
-- Password hashes use application-level scrypt. Session and invitation tokens
-- are stored as irreversible hashes; raw tokens are never persisted.

CREATE TABLE api_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  disabled_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_api_users_email_active
  ON api_users (lower(email))
  WHERE disabled_at IS NULL;

CREATE TABLE api_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES api_users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_sessions_user_id ON api_sessions(user_id);
CREATE INDEX idx_api_sessions_token_hash_active
  ON api_sessions(token_hash)
  WHERE revoked_at IS NULL;

CREATE TABLE api_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  token_hash      TEXT NOT NULL UNIQUE,
  invited_by      UUID REFERENCES api_users(id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_invitations_token_hash_open
  ON api_invitations(token_hash)
  WHERE accepted_at IS NULL;
