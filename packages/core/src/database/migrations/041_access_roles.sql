CREATE TABLE IF NOT EXISTS access_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_sensitivity_level TEXT NOT NULL,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT access_roles_id_required_check CHECK (length(trim(id)) > 0),
  CONSTRAINT access_roles_name_required_check CHECK (length(trim(name)) > 0),
  CONSTRAINT access_roles_max_sensitivity_level_check CHECK (
    max_sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT access_roles_permissions_allowed_check CHECK (
    permissions <@ ARRAY['read','write','review','classify','delete','admin','export','agent_config']::TEXT[]
  ),
  CONSTRAINT access_roles_permissions_not_empty_check CHECK (cardinality(permissions) > 0)
);

CREATE INDEX IF NOT EXISTS idx_access_roles_max_sensitivity_level
  ON access_roles(max_sensitivity_level);

INSERT INTO access_roles (id, name, max_sensitivity_level, permissions)
VALUES
  ('analyst', 'Analyst', 'internal', ARRAY['read']::TEXT[]),
  ('reviewer', 'Reviewer', 'restricted', ARRAY['read','review','classify']::TEXT[]),
  ('admin', 'Administrator', 'confidential', ARRAY['read','write','review','classify','delete','admin','export','agent_config']::TEXT[])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  max_sensitivity_level = EXCLUDED.max_sensitivity_level,
  permissions = EXCLUDED.permissions,
  updated_at = now();
