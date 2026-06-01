"use client";

import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type EmbeddingStatus = "pending" | "processing" | "completed" | "failed";

type EmbeddingError =
  | "rate_limit"
  | "auth_error"
  | "model_not_found"
  | "server_error"
  | "dimensions_mismatch"
  | "unknown";

const EMBEDDING_ERROR_MESSAGES: Record<EmbeddingError, string> = {
  rate_limit:
    "The embedding provider is rate limited. Retry after limits reset or switch providers.",
  auth_error:
    "The embedding provider rejected the API key or permissions. Check provider credentials.",
  model_not_found:
    "The configured embedding model was not found. Check the model name in settings.",
  server_error:
    "The embedding provider returned a server error. Retry later or use another provider.",
  dimensions_mismatch:
    "The embedding dimensions do not match the database index. Check the embedding model dimensions.",
  unknown: "Embedding failed for an unknown reason. Check logs and retry.",
};

export function EmbeddingStatusBadge({
  status,
  error,
}: {
  status: EmbeddingStatus;
  error?: EmbeddingError | null;
}) {
  const tooltip =
    status === "failed"
      ? error
        ? EMBEDDING_ERROR_MESSAGES[error]
        : EMBEDDING_ERROR_MESSAGES.unknown
      : null;

  const badge = (
    <Badge
      variant={status === "failed" ? "destructive" : "secondary"}
      className="text-xs"
      title={tooltip ?? undefined}
      tabIndex={tooltip ? 0 : undefined}
    >
      {status === "processing" && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === "completed"
        ? "Indexed"
        : status === "failed"
          ? "Failed"
          : status}
    </Badge>
  );

  if (!tooltip) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-72">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
