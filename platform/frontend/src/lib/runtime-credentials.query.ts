import {
  archestraApiSdk,
  type archestraApiTypes,
  type ResourceAccessRelation,
} from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { holdsItemGrant } from "@/lib/auth/auth.utils";
import { rememberGitHubConnectionReturn } from "@/lib/github-connection-return";
import { PERSISTED_QUERY_META } from "@/lib/query-persistence";
import { reportApiError, throwOnApiError } from "@/lib/utils/api";

const {
  createRuntimeCredential,
  deleteRuntimeCredential,
  deleteOrganizationRuntimeCredentialConnection,
  deletePersonalRuntimeCredentialConnection,
  getRuntimeCredentialUsage,
  listRuntimeCredentials,
  setOrganizationRuntimeCredentialConnection,
  setPersonalRuntimeCredentialConnection,
  updateRuntimeCredential,
} = archestraApiSdk;

export type RuntimeCredentialDefinition =
  archestraApiTypes.ListRuntimeCredentialsResponses["200"][number];
export type RuntimeCredentialUsage =
  archestraApiTypes.GetRuntimeCredentialUsageResponses["200"];

export const runtimeCredentialsQueryKey = ["runtime-credentials"] as const;
export const runtimeCredentialUsageQueryKey = (key: string | null) =>
  ["runtime-credential-usage", key] as const;

/**
 * The Credentials page's list, narrowed by its access filters. Pickers
 * elsewhere use {@link useRuntimeCredentials}, which lists every credential
 * the viewer can read.
 */
export function useFilteredRuntimeCredentials(params: {
  access: ResourceAccessRelation[];
  sharedWith?: string[];
  owner?: string[];
}) {
  const { access, sharedWith, owner } = params;
  return useQuery({
    queryKey: [...runtimeCredentialsQueryKey, { access, sharedWith, owner }],
    queryFn: async () => {
      const { data, error } = await listRuntimeCredentials({
        query: { access, sharedWith, owner },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    placeholderData: keepPreviousData,
    refetchOnMount: "always",
  });
}

export function useRuntimeCredentials(enabled = true) {
  return useQuery({
    queryKey: runtimeCredentialsQueryKey,
    queryFn: async () => {
      const { data, error } = await listRuntimeCredentials();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled,
    // Restored on refresh, like the other settings lists this page sits
    // beside: without it, `/settings/credentials` always sits behind a
    // "Loading credentials…" placeholder while other settings pages'
    // persisted queries paint their last-known data immediately. Definitions
    // carry no secret material — only metadata plus `personalConfigured`/
    // `organizationConfigured` booleans — so nothing sensitive enters the
    // snapshot.
    meta: PERSISTED_QUERY_META,
    // A restored `personalConfigured`/`organizationConfigured` value can be
    // acted on (e.g. an agent picks this credential believing it's
    // connected), so a mount always revalidates in the background instead of
    // waiting out the default staleTime — the same guarantee `useOrganization`
    // gives its `fresh` callers.
    refetchOnMount: "always",
  });
}

/** `silent` skips the success toast, for a caller that shows the result itself. */
export function useCreateRuntimeCredential({ silent = false } = {}) {
  return useCredentialMutation(
    async (body: archestraApiTypes.CreateRuntimeCredentialData["body"]) => {
      const { data, error } = await createRuntimeCredential({ body });
      if (error) throw reportApiError(error);
      return data;
    },
    (_, body) => {
      if (!silent) toast.success(`${body.name} added`);
    },
  );
}

export function useRuntimeCredentialUsage(key: string | null, enabled = true) {
  return useQuery({
    queryKey: runtimeCredentialUsageQueryKey(key),
    queryFn: async () => {
      if (!key) return { agents: [], resources: [] };
      const { data, error } = await getRuntimeCredentialUsage({
        path: { key },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? { agents: [], resources: [] };
    },
    enabled: enabled && Boolean(key),
    // References can change on other pages between openings of the delete dialog.
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useUpdateRuntimeCredential() {
  return useCredentialMutation(
    async ({
      key,
      body,
    }: {
      key: string;
      name: string;
      body: archestraApiTypes.UpdateRuntimeCredentialData["body"];
    }) => {
      const { data, error } = await updateRuntimeCredential({
        path: { key },
        body,
      });
      if (error) throw reportApiError(error);
      return data;
    },
    (_, input) => toast.success(`${input.name} updated`),
  );
}

export function useDeleteRuntimeCredential() {
  return useCredentialMutation(
    async ({ key }: { key: string; name: string }) => {
      const { data, error } = await deleteRuntimeCredential({
        path: { key },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    (_, input) => toast.success(`${input.name} deleted`),
  );
}

/** `silent` skips the success toast, for a caller that shows the result itself. */
export function useSetRuntimeCredentialConnection({ silent = false } = {}) {
  return useCredentialMutation(
    async (input: {
      key: string;
      name: string;
      scope: "personal" | "organization";
      value: string;
    }) => {
      const { key, scope, value } = input;
      const request = { path: { key }, body: { value } };
      const { data, error } =
        scope === "personal"
          ? await setPersonalRuntimeCredentialConnection(request)
          : await setOrganizationRuntimeCredentialConnection(request);
      if (error) throw reportApiError(error);
      return data;
    },
    (_, input) => {
      if (!silent) toast.success(`${input.name} connected`);
    },
  );
}

export function useDeleteRuntimeCredentialConnection() {
  return useCredentialMutation(
    async (input: {
      key: string;
      name: string;
      scope: "personal" | "organization";
    }) => {
      const { key, scope } = input;
      const request = { path: { key } };
      const { data, error } =
        scope === "personal"
          ? await deletePersonalRuntimeCredentialConnection(request)
          : await deleteOrganizationRuntimeCredentialConnection(request);
      if (error) throw reportApiError(error);
      return data;
    },
    (_, input) => toast.success(`${input.name} disconnected`),
  );
}

function useCredentialMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
  onSuccess?: (data: TOutput, input: TInput) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data, input) => {
      onSuccess?.(data, input);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: runtimeCredentialsQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["github-app-configs"] }),
        queryClient.invalidateQueries({ queryKey: ["github-pats"] }),
      ]);
    },
  });
}

export function useStartGitHubUserConnection() {
  return useMutation({
    mutationFn: async (key: string) => {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const { data, error } = await archestraApiSdk.startGitHubUserConnection({
        path: { key },
      });
      if (error) throw reportApiError(error);
      if (data) {
        const state = new URL(data.authorizationUrl).searchParams.get("state");
        if (state) rememberGitHubConnectionReturn(state, returnTo);
      }
      return data;
    },
    onSuccess: (data) => {
      if (data) window.location.assign(data.authorizationUrl);
    },
  });
}

export function useCompleteGitHubUserConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.CompleteGitHubUserConnectionData["body"],
    ) => {
      const { data, error } =
        await archestraApiSdk.completeGitHubUserConnection({
          body,
          signal: AbortSignal.timeout(45_000),
        });
      if (error) throw reportApiError(error);
      return data;
    },
    retry: false,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: runtimeCredentialsQueryKey });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(`Connected GitHub${data ? ` as ${data.login}` : ""}`);
    },
  });
}

/**
 * Whether the caller holds `use` on every credential: a grant at `*`, not one
 * gathered credential by credential. Binding a credential to guardrails helper
 * code, uploading a package, or approving a pull that rebinds one hands a
 * credential's value to code, so each needs it.
 */
export function useCanUseEveryCredential() {
  // `use` is a grant action, not a role action, so the role-permission type
  // does not list it; the scoped check below reads grants.
  return useHasPermissions(
    { credential: ["use"] } as unknown as Parameters<
      typeof useHasPermissions
    >[0],
    "*",
  );
}

/**
 * Whether the caller may attach each saved credential, by its id. Attaching
 * one hands its value to every run of the server or Agent, so it takes `use`.
 */
export function useCanAttachCredential() {
  const { data: grants } = useScopedCapabilities();
  return (credentialId: string) =>
    holdsItemGrant({
      grants,
      resource: "credential",
      action: "use",
      id: credentialId,
    });
}
