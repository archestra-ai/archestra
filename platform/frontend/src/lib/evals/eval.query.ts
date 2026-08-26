import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "../utils";

const {
  bulkDeleteEvalSuites,
  getEvalSuites,
  createEvalSuite,
  getEvalSuite,
  updateEvalSuite,
  deleteEvalSuite,
  getEvalSuiteCases,
  createEvalSuiteCase,
  updateEvalCase,
  deleteEvalCase,
  createEvalRun,
  getEvalRuns,
  getEvalRun,
  getEvalRunResults,
  cancelEvalRun,
} = archestraApiSdk;

export type EvalSuite =
  archestraApiTypes.GetEvalSuitesResponses["200"]["data"][number];
export type EvalCase =
  archestraApiTypes.GetEvalSuiteCasesResponses["200"][number];
export type EvalAssertion = EvalCase["assertions"][number];
export type EvalRun =
  archestraApiTypes.GetEvalRunsResponses["200"]["data"][number];
export type EvalRunDetail = archestraApiTypes.GetEvalRunResponses["200"];
export type EvalRunResult =
  archestraApiTypes.GetEvalRunResultsResponses["200"]["data"][number];

export const evalKeys = {
  all: ["evals"] as const,
  suites: (params: { limit?: number; offset?: number; name?: string }) =>
    [...evalKeys.all, "suites", params] as const,
  suite: (suiteId: string) => [...evalKeys.all, "suite", suiteId] as const,
  cases: (suiteId: string) => [...evalKeys.all, "cases", suiteId] as const,
  runs: (params: {
    suiteId?: string;
    agentId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => [...evalKeys.all, "runs", params] as const,
  run: (runId: string) => [...evalKeys.all, "run", runId] as const,
  runResults: (runId: string, params: { limit?: number; offset?: number }) =>
    [...evalKeys.all, "run", runId, "results", params] as const,
};

// === Suites ===

export function useEvalSuites(params: {
  limit?: number;
  offset?: number;
  name?: string;
}) {
  return useQuery({
    queryKey: evalKeys.suites(params),
    queryFn: async () => {
      const { data, error } = await getEvalSuites({ query: params });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useEvalSuite(suiteId: string | null) {
  return useQuery({
    queryKey: evalKeys.suite(suiteId ?? ""),
    enabled: !!suiteId,
    queryFn: async () => {
      if (!suiteId) return null;
      const { data, error } = await getEvalSuite({ path: { id: suiteId } });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
  });
}

export function useCreateEvalSuite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateEvalSuiteData["body"]) => {
      const { data, error } = await createEvalSuite({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Eval suite created");
      queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });
}

export function useUpdateEvalSuite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      suiteId: string;
      body: archestraApiTypes.UpdateEvalSuiteData["body"];
    }) => {
      const { data, error } = await updateEvalSuite({
        path: { id: params.suiteId },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Eval suite updated");
      queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });
}

export function useBulkDeleteEvalSuites() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { data, error } = await bulkDeleteEvalSuites({ body: { ids } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (outcome) => {
      if (!outcome) return;
      if (outcome.failed.length > 0) {
        toast.warning(
          `Deleted ${outcome.succeeded.length}; ${outcome.failed.length} could not be deleted`,
        );
      } else {
        toast.success(
          `Deleted ${outcome.succeeded.length} eval ${outcome.succeeded.length === 1 ? "suite" : "suites"}`,
        );
      }
      queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });
}

export function useDeleteEvalSuite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (suiteId: string) => {
      const { error } = await deleteEvalSuite({ path: { id: suiteId } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
    },
    onSuccess: () => {
      toast.success("Eval suite deleted");
      queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });
}

// === Cases ===

export function useEvalSuiteCases(suiteId: string | null) {
  return useQuery({
    queryKey: evalKeys.cases(suiteId ?? ""),
    enabled: !!suiteId,
    queryFn: async () => {
      if (!suiteId) return [];
      const { data, error } = await getEvalSuiteCases({
        path: { id: suiteId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useCreateEvalCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      suiteId: string;
      body: archestraApiTypes.CreateEvalSuiteCaseData["body"];
    }) => {
      const { data, error } = await createEvalSuiteCase({
        path: { id: params.suiteId },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Case added");
      queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });
}

export function useUpdateEvalCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      caseId: string;
      body: archestraApiTypes.UpdateEvalCaseData["body"];
    }) => {
      const { data, error } = await updateEvalCase({
        path: { id: params.caseId },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Case updated");
      queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });
}

export function useDeleteEvalCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (caseId: string) => {
      const { error } = await deleteEvalCase({ path: { id: caseId } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
    },
    onSuccess: () => {
      toast.success("Case deleted");
      queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });
}

// === Runs ===

export function useCreateEvalRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      suiteId: string;
      body: archestraApiTypes.CreateEvalRunData["body"];
    }) => {
      const { data, error } = await createEvalRun({
        path: { id: params.suiteId },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Eval run started");
      queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });
}

export function useEvalRuns(params: {
  suiteId?: string;
  agentId?: string;
  status?: archestraApiTypes.GetEvalRunsData["query"] extends infer Q
    ? Q extends { status?: infer S }
      ? S
      : never
    : never;
  limit?: number;
  offset?: number;
  /** Poll at this interval only while the page contains an unfinished run. */
  pollWhileActiveMs?: number;
}) {
  const { pollWhileActiveMs, ...query } = params;
  return useQuery({
    queryKey: evalKeys.runs(query),
    refetchInterval: pollWhileActiveMs
      ? (q) => {
          const runs = q.state.data?.data ?? [];
          return runs.some(
            (run) => run.status === "pending" || run.status === "running",
          )
            ? pollWhileActiveMs
            : false;
        }
      : undefined,
    queryFn: async () => {
      const { data, error } = await getEvalRuns({ query });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useEvalRun(
  runId: string | null,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: evalKeys.run(runId ?? ""),
    enabled: !!runId,
    refetchInterval: options?.refetchInterval,
    queryFn: async () => {
      if (!runId) return null;
      const { data, error } = await getEvalRun({ path: { id: runId } });
      throwOnApiError(error, { allowNotFound: true });
      return data ?? null;
    },
  });
}

export function useEvalRunResults(params: {
  runId: string | null;
  limit?: number;
  offset?: number;
  refetchInterval?: number | false;
}) {
  const { runId, refetchInterval, ...pagination } = params;
  return useQuery({
    queryKey: evalKeys.runResults(runId ?? "", pagination),
    enabled: !!runId,
    refetchInterval,
    queryFn: async () => {
      if (!runId) return null;
      const { data, error } = await getEvalRunResults({
        path: { id: runId },
        query: pagination,
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

export function useCancelEvalRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => {
      const { data, error } = await cancelEvalRun({ path: { id: runId } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Eval run canceled");
      queryClient.invalidateQueries({ queryKey: evalKeys.all });
    },
  });
}
