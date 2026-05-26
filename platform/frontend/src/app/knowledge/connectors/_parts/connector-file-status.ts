type ConnectorFileStatusVariant = "default" | "secondary" | "destructive";

type ConnectorFileProcessingStatus = "pending" | "processing" | "failed";
type ConnectorFileEmbeddingStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export const CONNECTOR_FILE_EMBEDDING_ERROR_MESSAGES = {
  invalid_credentials:
    "The embedding provider rejected the credentials. Check the configured API key or token.",
  network_error:
    "Archestra could not reach the embedding provider. Check network access and try again.",
  provider_misconfigured:
    "The embedding provider is misconfigured. Verify the base URL, deployment, and model settings.",
  provider_unavailable:
    "The embedding provider returned a server-side failure. Try again in a few minutes.",
  rate_limited:
    "The embedding provider rate limited this request. Try again after the limit resets.",
  unsupported_input:
    "The selected embedding model cannot process this file content. Use a compatible embedding model and try again.",
  unknown:
    "Archestra could not generate embeddings for this file. Check the embedding provider logs and try again.",
} as const;

export type ConnectorFileEmbeddingError =
  keyof typeof CONNECTOR_FILE_EMBEDDING_ERROR_MESSAGES;

export type ConnectorFileStatusMeta = {
  label: string;
  tooltip?: string;
  variant: ConnectorFileStatusVariant;
  showSpinner?: boolean;
};

export function getConnectorFileStatusMeta(params: {
  processingStatus?: string | null;
  embeddingStatus?: string | null;
  processingError?: string | null;
  embeddingError?: string | null;
}): ConnectorFileStatusMeta {
  const processingStatus = normalizeProcessingStatus(params.processingStatus);
  if (processingStatus) {
    switch (processingStatus) {
      case "pending":
        return {
          label: "Queued",
          tooltip: "File is queued for text extraction.",
          variant: "secondary",
        };
      case "processing":
        return {
          label: "Extracting...",
          tooltip: "Extracting text from the uploaded file.",
          variant: "secondary",
          showSpinner: true,
        };
      case "failed":
        return {
          label: "Processing Failed",
          tooltip:
            params.processingError ??
            "Archestra could not extract text from this file.",
          variant: "destructive",
        };
    }
  }

  const embeddingStatus = normalizeEmbeddingStatus(params.embeddingStatus);
  switch (embeddingStatus) {
    case "completed":
      return { label: "Indexed", variant: "default" };
    case "pending":
      return { label: "Pending", variant: "secondary" };
    case "processing":
      return {
        label: "Indexing...",
        tooltip: "Generating embeddings for this file.",
        variant: "secondary",
        showSpinner: true,
      };
    case "failed":
      return {
        label: "Indexing Failed",
        tooltip: getEmbeddingErrorMessage(params.embeddingError),
        variant: "destructive",
      };
    default:
      return {
        label: params.embeddingStatus ?? "Unknown",
        variant: "secondary",
      };
  }
}

export function getEmbeddingErrorMessage(
  embeddingError?: string | null,
): string {
  if (!embeddingError) {
    return CONNECTOR_FILE_EMBEDDING_ERROR_MESSAGES.unknown;
  }

  return (
    CONNECTOR_FILE_EMBEDDING_ERROR_MESSAGES[
      embeddingError as ConnectorFileEmbeddingError
    ] ?? CONNECTOR_FILE_EMBEDDING_ERROR_MESSAGES.unknown
  );
}

function normalizeProcessingStatus(
  status?: string | null,
): ConnectorFileProcessingStatus | null {
  if (status === "pending" || status === "processing" || status === "failed") {
    return status;
  }
  return null;
}

function normalizeEmbeddingStatus(
  status?: string | null,
): ConnectorFileEmbeddingStatus {
  if (
    status === "pending" ||
    status === "processing" ||
    status === "completed" ||
    status === "failed"
  ) {
    return status;
  }
  return "pending";
}
