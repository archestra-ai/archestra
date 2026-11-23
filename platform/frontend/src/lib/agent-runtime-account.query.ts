import {
  archestraApiSdk,
  type archestraApiTypes,
  COMPANY_ACCOUNT_WORDS,
  type CompanyAccountWords,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reportApiError, throwOnApiError } from "@/lib/utils/api";

/**
 * The account the viewer's runs of an agent use. `companyAccount` is the
 * company option as their runs resolve it now: each part is decided by the
 * runtime's settings, then the agent's, then the person, and `fixedBy` names
 * the level that fixed it, null leaving it to the person. A part's `id` is
 * null where nothing resolves, and while a choice of theirs no longer works.
 */
export type AgentRuntimeAccount =
  archestraApiTypes.GetAgentRuntimeAccountResponses["200"];
export type CompanyAccount = AgentRuntimeAccount["companyAccount"];
/**
 * What the viewer chooses for their own runs. Each save replaces the choice
 * whole: a connection or model it leaves out is stored as none.
 */
export type AgentRuntimeAccountChoice =
  archestraApiTypes.UpdateAgentRuntimeAccountData["body"];
export type AgentRuntimeAccountLock = NonNullable<
  archestraApiTypes.UpdateAgentData["body"]["runtime"]
>["accountLock"] & {};

/** The account the viewer's own runs of an agent use, and what they chose. */
export function useAgentRuntimeAccount(agentId: string, enabled = true) {
  return useQuery({
    queryKey: accountKey(agentId),
    enabled: Boolean(agentId) && enabled,
    // A subscription connected in another tab shows as connected on return.
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getAgentRuntimeAccount({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

/** Save the viewer's choice, or clear it with null: back to the agent's default. */
export function useSaveAgentRuntimeAccount(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (choice: AgentRuntimeAccountChoice | null) => {
      const request = { path: { id: agentId } };
      const { data, error } = choice
        ? await archestraApiSdk.updateAgentRuntimeAccount({
            ...request,
            body: choice,
          })
        : await archestraApiSdk.clearAgentRuntimeAccount(request);
      if (error) throw reportApiError(error);
      return data;
    },
    // The choice shows at once: whatever reads the account changes in one
    // step, on the click, instead of once on the answer and again on the
    // refetch. A refusal puts back the account as it was, through `onError`.
    onMutate: async (choice) => {
      await client.cancelQueries({ queryKey: accountKey(agentId) });
      const previous = client.getQueryData<AgentRuntimeAccount | null>(
        accountKey(agentId),
      );
      client.setQueryData<AgentRuntimeAccount | null>(
        accountKey(agentId),
        (current) =>
          current && {
            ...current,
            choice: choice && {
              authentication: choice.authentication,
              llmApiKeyId: choice.llmApiKeyId ?? null,
              modelId: choice.modelId ?? null,
              claudeModel: choice.claudeModel ?? null,
            },
            choiceError: null,
            ...(choice?.authentication === "provider" && {
              companyAccount: companyAccountAfter(
                current.companyAccount,
                choice,
              ),
            }),
          },
      );
      return { previous };
    },
    onSuccess: (data, choice) => {
      if (data) client.setQueryData(accountKey(agentId), data);
      void client.invalidateQueries({ queryKey: accountKey(agentId) });
      void client.invalidateQueries({
        queryKey: ["agents", agentId, "runtime", "preflight"],
      });
      toast.success(
        choice ? "Your account is saved" : "Your runs use the agent's default",
      );
    },
    // The account goes back to what it was before the click, even when it
    // cannot be read again. What is stored may also have moved under the
    // person (a key removed, a lock set), so it is read again.
    onError: (_error, _choice, context) => {
      if (context?.previous !== undefined) {
        client.setQueryData(accountKey(agentId), context.previous);
      }
      void client.invalidateQueries({ queryKey: accountKey(agentId) });
    },
  });
}

/** What an account lock means for every person's runs, in a sentence. */
export function accountLockDescription(
  lock: AgentRuntimeAccountLock | null | undefined,
  words: CompanyAccountWords = COMPANY_ACCOUNT_WORDS,
): string | null {
  switch (lock) {
    case "subscription":
      return "This agent runs only on each person's own subscription.";
    case "key":
      return `This agent runs only on ${words.a}.`;
    default:
      return null;
  }
}

/**
 * The company account as it reads once the person's pick is stored. Only a
 * part left to them takes what they picked, by id; the names come with the
 * answer, and until then whatever lists them names them. A connection of
 * their own leaves the model theirs or none: the default that resolves on it
 * comes with the answer. With nothing picked, what resolved without a pick
 * stays as it reads.
 */
function companyAccountAfter(
  account: CompanyAccount,
  choice: AgentRuntimeAccountChoice,
): CompanyAccount {
  const modelOpen = account.model.fixedBy === null;
  const llmApiKeyId =
    account.connection.fixedBy === null ? (choice.llmApiKeyId ?? null) : null;
  const modelId = modelOpen ? (choice.modelId ?? null) : null;
  if (!llmApiKeyId && !modelId) return account;
  return {
    ...account,
    connection: llmApiKeyId
      ? { ...account.connection, id: llmApiKeyId, name: null, provider: null }
      : account.connection,
    model: modelOpen
      ? { ...account.model, id: modelId, name: null }
      : account.model,
    // A pick of their own is not the organization default.
    usesOrganizationDefault: false,
  };
}

function accountKey(agentId: string) {
  return ["agents", agentId, "runtime", "account"] as const;
}
