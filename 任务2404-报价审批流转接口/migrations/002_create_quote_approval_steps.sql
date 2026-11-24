-- Sales quote approval steps: append-only decision log.
-- A pending / approved / rejected / skipped row is INSERTed for every action;
-- existing rows are never UPDATEd. The current action of a step is the row with
-- the greatest id for that (approval_id, step_no) pair.

CREATE TABLE IF NOT EXISTS sales_quote_approval_steps (
    id            VARCHAR(32) PRIMARY KEY,
    approval_id   VARCHAR(32)  NOT NULL REFERENCES sales_quote_approvals (id),
    step_no       INTEGER      NOT NULL,
    approver_id   VARCHAR(64)  NOT NULL,
    approver_role VARCHAR(32)  NOT NULL,
    action        VARCHAR(16)  NOT NULL
                  CHECK (action IN ('pending', 'approved', 'rejected', 'skipped')),
    comment       TEXT         NOT NULL DEFAULT '',
    acted_at      TIMESTAMPTZ,
    client_ip     VARCHAR(64),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quote_approval_steps_approval
    ON sales_quote_approval_steps (approval_id, step_no, id);

-- Enforce append-only semantics at the database boundary in production.
-- REVOKE UPDATE, DELETE ON sales_quote_approval_steps FROM PUBLIC;
