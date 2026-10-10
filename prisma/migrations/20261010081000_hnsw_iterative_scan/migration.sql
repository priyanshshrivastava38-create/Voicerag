-- Permission filters are applied to HNSW results; with a narrow scope the default scan can
-- return fewer than LIMIT rows. pgvector >= 0.8 iterative scans keep searching until enough
-- filtered rows are found. Applies to new connections of this database.
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET hnsw.iterative_scan = relaxed_order', current_database());
  EXECUTE format('ALTER DATABASE %I SET hnsw.ef_search = 64', current_database());
END $$;
