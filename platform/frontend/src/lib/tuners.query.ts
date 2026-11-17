import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getApiErrorType,
  handleApiError,
  throwOnApiError,
  toApiError,
} from "@/lib/utils/api";

const {
  listTuners,
  configureTuner,
  runTuner,
  listTunerSuggestions,
  markTunerSuggestionDone,
  rejectTunerSuggestion,
  applyTunerSuggestion,
  refreshTunerSuggestion,
} = archestraApiSdk;

export type TunerSummary = archestraApiTypes.ListTunersResponses["200"][number];
export type TunerKind = TunerSummary["kind"];
export type TunerSuggestion =
  archestraApiTypes.ListTunerSuggestionsResponses["200"]["data"][number];
export type TunerSuggestionStatus = TunerSuggestion["status"];
type TunerSuggestionsQuery = NonNullable<
  archestraApiTypes.ListTunerSuggestionsData["query"]
>;
type ConfigureTunerBody = archestraApiTypes.ConfigureTunerData["body"];

export type TunerSuggestionAction =
  | { type: "done"; id: string; comment: string | null }
  | { type: "reject"; id: string; comment: string }
  | { type: "apply"; id: string }
  | { type: "refresh"; id: string };

export function useTuners() {
  return useQuery({
    queryKey: tunerKeys.list,
    queryFn: async () => {
      const { data, error } = await listTuners();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useConfigureTuner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      kind,
      body,
    }: {
      kind: TunerKind;
      body: ConfigureTunerBody;
    }) => {
      const { data, error } = await configureTuner({ path: { kind }, body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (tuners) => {
      queryClient.setQueryData(tunerKeys.list, tuners);
      toast.success("Tuner updated");
    },
  });
}

export function useRunTuner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (kind: TunerKind) => {
      const { data, error } = await runTuner({ path: { kind } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => toast.success("Tuner run started"),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: tunerKeys.list }),
  });
}

export function useTunerSuggestions(query: TunerSuggestionsQuery) {
  return useQuery({
    queryKey: [...tunerKeys.suggestions, query],
    queryFn: async () => {
      const { data, error } = await listTunerSuggestions({ query });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    placeholderData: keepPreviousData,
  });
}

/**
 * Acts on one suggestion. Resolves with the updated suggestion, or with null
 * when it changed underneath the reader (409): the inbox refetches instead.
 */
export function useTunerSuggestionAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: TunerSuggestionAction) => {
      const { data, error } = await callAction(action);
      if (!error) return data ?? null;
      if (getApiErrorType(error) === "api_conflict_error") {
        toast.error("This suggestion changed in the meantime. Reloaded it.");
        return null;
      }
      handleApiError(error);
      throw toApiError(error);
    },
    onSuccess: (suggestion, action) => {
      if (suggestion) toast.success(ACTION_SUCCESS[action.type]);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: tunerKeys.suggestions }),
  });
}

// === Internal helpers

const tunerKeys = {
  list: ["tuners", "list"] as const,
  suggestions: ["tuners", "suggestions"] as const,
};

const ACTION_SUCCESS: Record<TunerSuggestionAction["type"], string> = {
  done: "Suggestion marked done",
  reject: "Suggestion rejected",
  apply: "Policy change applied",
  refresh: "Suggestion refreshed",
};

function callAction(action: TunerSuggestionAction) {
  const path = { id: action.id };
  switch (action.type) {
    case "done":
      return markTunerSuggestionDone({
        path,
        body: { comment: action.comment },
      });
    case "reject":
      return rejectTunerSuggestion({ path, body: { comment: action.comment } });
    case "apply":
      return applyTunerSuggestion({ path });
    case "refresh":
      return refreshTunerSuggestion({ path });
  }
}
