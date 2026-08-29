import type { EvalCapability, KnowledgeEvaluationComponent } from "./schema";

interface KnowledgeEvaluationComponentDefinition {
  id: KnowledgeEvaluationComponent;
  label: string;
  description: string;
  unavailableDescription: string;
  mode: "offline" | "online";
  requires: EvalCapability[];
}

export const KNOWLEDGE_EVALUATION_COMPONENT_DEFINITIONS: readonly KnowledgeEvaluationComponentDefinition[] =
  [
    {
      id: "chunking",
      label: "Chunking",
      description: "Checks whether documents split into searchable sections.",
      unavailableDescription: "Chunking is unavailable.",
      mode: "offline",
      requires: [],
    },
    {
      id: "text-embedding",
      label: "Text embedding",
      description: "Checks whether the selected model can store and find text.",
      unavailableDescription: "Configure an embedding key and model.",
      mode: "online",
      requires: ["text-embedding"],
    },
    {
      id: "image-embedding",
      label: "Image embedding",
      description:
        "Checks whether the selected model can store and find images.",
      unavailableDescription: "Choose an embedding model that accepts images.",
      mode: "online",
      requires: ["image-embedding"],
    },
    {
      id: "keyword-ranking",
      label: "Keyword ranking",
      description: "Checks keyword search with the current ranking settings.",
      unavailableDescription:
        "Ask a platform operator to enable hybrid search for this deployment.",
      mode: "offline",
      requires: ["hybrid-search"],
    },
    {
      id: "hybrid-retrieval",
      label: "Hybrid retrieval",
      description: "Checks combined semantic and keyword search.",
      unavailableDescription:
        "Configure text embedding; hybrid search is managed at deployment level.",
      mode: "online",
      requires: ["text-embedding", "hybrid-search"],
    },
    {
      id: "reranking",
      label: "Reranking",
      description: "Checks whether the selected model can reorder results.",
      unavailableDescription: "Configure text embedding and a reranking model.",
      mode: "online",
      requires: ["text-embedding", "reranker"],
    },
    {
      id: "query-expansion",
      label: "Query expansion",
      description:
        "Checks whether the selected model can expand a search query.",
      unavailableDescription:
        "Configure text embedding and a text-generating reranking model.",
      mode: "online",
      requires: ["text-embedding", "query-expansion"],
    },
    {
      id: "contextual-retrieval",
      label: "Contextual retrieval",
      description: "Checks whether document context improves search results.",
      unavailableDescription:
        "Enable contextual retrieval and configure its embedding and reranking models.",
      mode: "online",
      requires: ["text-embedding", "contextual-retrieval"],
    },
    {
      id: "context-expansion",
      label: "Context expansion",
      description:
        "Checks whether nearby document text is included in results.",
      unavailableDescription: "Set context expansion radius above zero.",
      mode: "offline",
      requires: ["context-expansion"],
    },
    {
      id: "ocr",
      label: "Document OCR",
      description: "Checks whether the selected model can read a scanned PDF.",
      unavailableDescription:
        "Configure text embedding and a document OCR model.",
      mode: "online",
      requires: ["text-embedding", "ocr"],
    },
  ];

export function componentDefinition(
  id: KnowledgeEvaluationComponent,
): KnowledgeEvaluationComponentDefinition {
  const definition = KNOWLEDGE_EVALUATION_COMPONENT_DEFINITIONS.find(
    (candidate) => candidate.id === id,
  );
  if (!definition)
    throw new Error(`Unknown knowledge evaluation component: ${id}`);
  return definition;
}
