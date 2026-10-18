"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const { getOpenappaExternalConsult, getOpenappaExternalConsults } =
  archestraApiSdk;

type ConsultsQuery = NonNullable<
  archestraApiTypes.GetOpenappaExternalConsultsData["query"]
>;
type ConsultsResponse =
  archestraApiTypes.GetOpenappaExternalConsultsResponses["200"];

export type ExternalConsult = ConsultsResponse["data"][number];
export type ExternalConsultOutcome = ExternalConsult["outcome"];
export type ExternalConsultFilters = Pick<
  ConsultsQuery,
  "search" | "outcome" | "from" | "to"
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

/**
 * One consult, with the LLM session and tool call it belongs to when those
 * were logged. Null when it does not exist or the viewer may not read it.
 */
export function useExternalConsult(id: string) {
  return useQuery({
    queryKey: [...EXTERNAL_CONSULTS_QUERY_KEY, "one", id],
    queryFn: async () => {
      const response = await getOpenappaExternalConsult({ path: { id } });
      if (response.response?.status === 404) return null;
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? null;
    },
  });
}

/**
 * Every consult raised in an LLM session, sub-agents included, oldest first.
 * Empty for a viewer who may not read consults: the trace then simply shows
 * no checks.
 */
export function useSessionConsults({
  llmSessionId,
  enabled,
}: {
  llmSessionId: string;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: [...EXTERNAL_CONSULTS_QUERY_KEY, "session", llmSessionId],
    enabled,
    queryFn: async () => {
      const rows: ExternalConsult[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < SESSION_CONSULT_PAGES; page++) {
        const response = await getOpenappaExternalConsults({
          query: { llmSessionId, limit: 100, cursor },
        });
        if (response.error) return rows.reverse();
        rows.push(...(response.data?.data ?? []));
        const next = response.data?.pagination.nextCursor;
        if (!next) break;
        cursor = next;
      }
      return rows.reverse();
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

/** A session's consults are read 100 at a time, up to this many pages. */
const SESSION_CONSULT_PAGES = 10;

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
