-- F056: one row per term, case-insensitively.
--
-- Without this, "New Term" with a term that already exists (in any casing)
-- silently creates a second row. Two rows for the same term are not just untidy:
-- they compete in the correction pass and both consume the capped decoder
-- prompt, so the duplicate is actively harmful.
--
-- Delivered as a follow-up migration rather than an edit to
-- 20260907000000_add_custom_dictionary.sql because that one may already have
-- been applied on a branch checkout, and sqlx rejects a migration whose checksum
-- changed after it ran.

-- Collapse any duplicates that predate the constraint, keeping the oldest row
-- for each term. The unique index cannot be created while duplicates exist.
DELETE FROM custom_dictionary
WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM custom_dictionary GROUP BY term COLLATE NOCASE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_dictionary_term_nocase
    ON custom_dictionary (term COLLATE NOCASE);
