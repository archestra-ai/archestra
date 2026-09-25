"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const { getOpenappaExternalConsults } = archestraApiSdk;

type ConsultsQuery = NonNullable<
  archestraApiTypes.GetOpenappaExternalConsultsData["query"]
>;
type ConsultsResponse =
  archestraApiTypes.GetOpenappaExternalConsultsResponses["200"];

export type ExternalConsult = ConsultsResponse["data"][number];
export type ExternalConsultOutcome = ExternalConsult["outcome"];
export type ExternalConsultFilters = Pick<
  ConsultsQuery,
  "externalName" | "outcome" | "sessionId" | "from" | "to"
>;

export function useExternalConsults({
  filters,
  limit = DEFAULT_TABLE_LIMIT,
  cursor,
}: {
  filters: ExternalConsultFilters;
  limit?: number;
  cursor?: string;
}) {
  return useQuery({
    queryKey: [...EXTERNAL_CONSULTS_QUERY_KEY, { filters, limit, cursor }],
    queryFn: async () => {
      const response = await getOpenappaExternalConsults({
        query: { ...filters, limit, cursor },
      });
      // The table renders its own QueryLoadError panel; don't also toast.
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? emptyResponse(limit);
    },
  });
}

/** Downloads every consult matching `filters` (newest first, server-capped) as JSONL. */
export function useExportExternalConsults() {
  return useMutation({
    mutationFn: async (filters: ExternalConsultFilters) => {
      const { data, error } = await getOpenappaExternalConsults({
        query: { ...filters, format: "jsonl" },
        parseAs: "blob",
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      if (!(data instanceof Blob)) {
        toast.error("The export did not return a file");
        throw new Error("The export did not return a file");
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      saveFile(data, `guardrail-consults-${stamp}.jsonl`);
    },
    onSuccess: () => toast.success("Export downloaded"),
  });
}

// === Internal helpers ===

const EXTERNAL_CONSULTS_QUERY_KEY = ["openappa-external-consults"] as const;

function emptyResponse(limit: number): ConsultsResponse {
  return { data: [], pagination: { limit, nextCursor: null, hasNext: false } };
}

function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  // Revoked on a delay: the browser reads the blob asynchronously after the click.
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 10_000);
}
