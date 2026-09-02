CREATE TABLE "kb_bm25_corpus_fingerprint" (
	"id" text PRIMARY KEY NOT NULL,
	"n_chunks" bigint NOT NULL,
	"newest_chunk_at" timestamp,
	"refreshed_at" timestamp DEFAULT now() NOT NULL
);
