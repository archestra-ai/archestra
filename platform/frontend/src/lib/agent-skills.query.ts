import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  getAgentActivationSkills: getAgentActivationSkillsApi,
  getAgentSkills,
  updateAgentSkills,
  getAgentSkillExclusions,
  updateAgentSkillExclusions,
} = archestraApiSdk;

type AgentSkillAssignments = archestraApiTypes.GetAgentSkillsResponses["200"];
type AgentSkillExclusions =
  archestraApiTypes.GetAgentSkillExclusionsResponses["200"];
export type AgentActivationSkills =
  archestraApiTypes.GetAgentActivationSkillsResponses["200"];
export type AgentActivationSkill = AgentActivationSkills["data"][number];

/**
 * The PUT bodies carry ids only; the GET responses additionally carry the rows
 * those ids name, because the paginated skill catalog cannot be relied on to
 * contain them (see `skills` in the response type).
 */
type AgentSkillAssignmentsInput = Omit<AgentSkillAssignments, "skills">;
type AgentSkillExclusionsInput = Omit<AgentSkillExclusions, "skills">;

export function useAgentActivationSkills(params: {
  agentId?: string;
  environmentId?: string | null;
  limit: number;
  offset: number;
  search?: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: [
      "agents",
      params.agentId ?? "draft",
      "activation-skills",
      params.environmentId ?? "default",
      params.limit,
      params.offset,
      params.search ?? "",
    ],
    enabled: params.enabled ?? true,
    queryFn: async (): Promise<AgentActivationSkills> => {
      const query = {
        ...(params.agentId
          ? { agentId: params.agentId }
          : params.environmentId
            ? { environmentId: params.environmentId }
            : {}),
        limit: params.limit,
        offset: params.offset,
        search: params.search,
      };
      const { data, error } = await getAgentActivationSkillsApi({ query });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Activation skills response carried no body");
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

/**
 * Fails loud on purpose. The caller seeds an editor from this and saves that
 * editor back as a full replace, so an empty default here is not a harmless
 * blank screen: it reads as "publishes nothing", and the next save writes that
 * back over whatever the gateway actually published.
 */
export function useAgentSkills(agentId: string | undefined) {
  return useQuery({
    queryKey: agentSkillsQueryKey(agentId ?? ""),
    queryFn: async (): Promise<AgentSkillAssignments> => {
      // `enabled` keeps this from running without an id; the guard is the type.
      if (!agentId) throw new Error("No agent id to read published skills for");
      const { data, error } = await getAgentSkills({ path: { id: agentId } });
      // No toast: the dialog renders its own error state for this failure, and
      // an errored query refetches on every window refocus — which turns one
      // failure into a stream of toasts behind a screen already saying so.
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Published skills response carried no body");
      return data;
    },
    enabled: !!agentId,
  });
}

export function useUpdateAgentSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      assignments: AgentSkillAssignmentsInput;
    }) => {
      const { data, error } = await updateAgentSkills({
        path: { id: params.agentId },
        body: params.assignments,
      });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (_data, { agentId }) => {
      queryClient.invalidateQueries({ queryKey: agentSkillsQueryKey(agentId) });
    },
  });
}

/** Fails loud for the same reason as {@link useAgentSkills}. */
export function useAgentSkillExclusions(agentId: string | undefined) {
  return useQuery({
    queryKey: agentSkillExclusionsQueryKey(agentId ?? ""),
    queryFn: async (): Promise<AgentSkillExclusions> => {
      // `enabled` keeps this from running without an id; the guard is the type.
      if (!agentId) throw new Error("No agent id to read skill exclusions for");
      const { data, error } = await getAgentSkillExclusions({
        path: { id: agentId },
      });
      // No toast: the dialog renders its own error state for this failure, and
      // an errored query refetches on every window refocus — which turns one
      // failure into a stream of toasts behind a screen already saying so.
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Skill exclusions response carried no body");
      return data;
    },
    enabled: !!agentId,
  });
}

export function useUpdateAgentSkillExclusions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      exclusions: AgentSkillExclusionsInput;
    }) => {
      const { data, error } = await updateAgentSkillExclusions({
        path: { id: params.agentId },
        body: params.exclusions,
      });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (_data, { agentId }) => {
      queryClient.invalidateQueries({
        queryKey: agentSkillExclusionsQueryKey(agentId),
      });
    },
  });
}

// === internal ===

function agentSkillsQueryKey(agentId: string) {
  return ["agents", agentId, "skills"] as const;
}

function agentSkillExclusionsQueryKey(agentId: string) {
  return ["agents", agentId, "skill-exclusions"] as const;
}
