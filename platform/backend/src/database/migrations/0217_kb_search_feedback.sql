CREATE TABLE kb_search_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_id(),
  organization_id text NOT NULL,
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  chunk_id uuid REFERENCES kb_chunks(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  user_id text NOT NULL,
  rating text NOT NULL CHECK (rating IN ('positive', 'negative')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kb_search_feedback_kb_id_idx ON kb_search_feedback(knowledge_base_id);
CREATE INDEX kb_search_feedback_document_id_idx ON kb_search_feedback(document_id);
CREATE INDEX kb_search_feedback_org_id_idx ON kb_search_feedback(organization_id);
