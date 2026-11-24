-- Sales quote approvals: one row per submitted quote revision.
-- status: pending / approved / rejected / withdrawn
-- snapshot_hash: SHA-256 of the canonical JSON of the quote calc_snapshot.
-- The in-memory demo mirrors these columns; this file is the persistence schema.

CREATE TABLE IF NOT EXISTS sales_quote_approvals (
    id             VARCHAR(32) PRIMARY KEY,
    quote_id       VARCHAR(64)  NOT NULL,
    revision       INTEGER      NOT NULL,
    tier           VARCHAR(32)  NOT NULL CHECK (tier IN ('rep', 'supervisor', 'site_manager')),
    status         VARCHAR(16)  NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    submitted_by   VARCHAR(64)  NOT NULL,
    submitted_at   TIMESTAMPTZ  NOT NULL,
    snapshot_hash  CHAR(64)     NOT NULL,
    decided_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quote_approvals_quote
    ON sales_quote_approvals (quote_id, revision);

CREATE INDEX IF NOT EXISTS idx_quote_approvals_status
    ON sales_quote_approvals (status, submitted_at);
