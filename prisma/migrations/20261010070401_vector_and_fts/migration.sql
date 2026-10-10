-- pgvector + full-text search columns that Prisma cannot model natively.
-- The embedding dimension (768) must match EMBED_DIM; changing models with a different
-- dimension requires a new migration and a full re-index.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "Chunk" ADD COLUMN "embedding" vector(768);
-- Maintained by trigger (not a generated column) so Prisma's schema diff stays clean.
ALTER TABLE "Chunk" ADD COLUMN "tsv" tsvector;
CREATE FUNCTION chunk_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW."tsv" := setweight(to_tsvector('english', coalesce(NEW."headingPath", '')), 'A') ||
               setweight(to_tsvector('english', NEW."text"), 'B');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER chunk_tsv_trigger BEFORE INSERT OR UPDATE OF "text", "headingPath" ON "Chunk"
  FOR EACH ROW EXECUTE FUNCTION chunk_tsv_update();

-- Approximate NN over active chunks; cosine distance matches normalised embeddings.
CREATE INDEX "Chunk_embedding_hnsw" ON "Chunk" USING hnsw ("embedding" vector_cosine_ops) WHERE "active";
CREATE INDEX "Chunk_tsv_gin" ON "Chunk" USING gin ("tsv") WHERE "active";

ALTER TABLE "EmbeddingCache" ADD COLUMN "embedding" vector(768) NOT NULL;

INSERT INTO "IndexState" ("id", "version") VALUES (1, 1) ON CONFLICT DO NOTHING;
