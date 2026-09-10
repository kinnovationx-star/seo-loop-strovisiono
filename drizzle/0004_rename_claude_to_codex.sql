-- Preserve existing client connection and generated-result history while
-- replacing the former provider identifier with the actual Codex engine.
UPDATE connections SET connector = 'codex' WHERE connector = 'claude';
UPDATE snapshots SET connector = 'codex' WHERE connector = 'claude';
