-- Stores non-terminal worker progress separately from the final job result.
-- Additive migration: existing jobs and their results are preserved.
ALTER TABLE jobs ADD COLUMN progress TEXT;
