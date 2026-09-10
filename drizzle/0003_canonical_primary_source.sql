ALTER TABLE sources ADD COLUMN is_canonical INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN canonical_status TEXT NOT NULL DEFAULT 'candidate';
ALTER TABLE sources ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE sources
SET is_canonical = 1,
    archived = 0,
    canonical_status = 'candidate',
    updated_at = created_at
WHERE id = (
  SELECT latest.id
  FROM sources AS latest
  WHERE latest.client_id = sources.client_id
  ORDER BY latest.created_at DESC, latest.id DESC
  LIMIT 1
);

UPDATE sources
SET archived = 1,
    is_canonical = 0,
    canonical_status = 'superseded',
    updated_at = CASE WHEN updated_at = '' THEN created_at ELSE updated_at END
WHERE is_canonical = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_one_canonical
ON sources(client_id)
WHERE is_canonical = 1;
