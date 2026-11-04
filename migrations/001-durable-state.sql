BEGIN;

CREATE SCHEMA IF NOT EXISTS ri_swap;

CREATE TABLE IF NOT EXISTS ri_swap.runtime_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL CHECK (revision >= 0),
  state jsonb NOT NULL,
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ri_swap.state_commits (
  revision bigint PRIMARY KEY CHECK (revision > 0),
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  state jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ri_swap.runtime_state (singleton, revision, state, state_hash)
VALUES (
  true,
  0,
  '{"participants":{},"business_links":{},"offers":{},"proposals":{},"acceptances":[],"agreements":[],"cancellations":[],"audit":[],"idempotency":{}}'::jsonb,
  '5c9c03fd14ded4fc12c7ce4cd17d877f2df54d5b621a381f75914ace0064f967'
)
ON CONFLICT (singleton) DO NOTHING;

COMMIT;

-- This migration deliberately creates no role and grants no privilege.
-- A database owner must separately grant the runtime role only SELECT/INSERT/UPDATE
-- on these two tables and USAGE on schema ri_swap. Never reuse RI-YELLOW's read role.
