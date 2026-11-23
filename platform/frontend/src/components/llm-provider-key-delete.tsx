"use client";

import type { archestraApiTypes } from "@archestra/shared";
import Link from "next/link";
import { SettingsLink } from "@/components/settings-link";
import { useOauthClients } from "@/lib/oauth-clients.query";
import { useOrganization } from "@/lib/organization.query";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";

// What removing an LLM provider key takes with it, and the notice that says
// so: shared by Model Providers and by the account card on an agent's page,
// so a disconnect reads the same wherever it starts.

/** Time a delete or disconnect dialog stays unconfirmable, so its notice gets read. */
export const PROVIDER_KEY_CONFIRM_DELAY_MS = 3000;

/**
 * What goes with a provider key when it is removed: the virtual keys and
 * OAuth clients that map only it, and the knowledge base jobs set to it.
 * `known` is false until the lists have answered, and stays false when one
 * could not be read: a caller that removes without asking must not then.
 */
export function useLlmProviderKeyDependents(params: {
  keyId: string | null;
  enabled?: boolean;
}) {
  const enabled = !!params.keyId && (params.enabled ?? true);
  const virtualKeys = useAllVirtualApiKeys({
    providerApiKeyId: params.keyId ?? undefined,
    limit: 100,
    offset: 0,
    enabled,
    toastOnError: false,
  });
  const oauthClients = useOauthClients({
    capability: "llm:proxy",
    providerApiKeyId: params.keyId ?? undefined,
    limit: 100,
    offset: 0,
    enabled,
    toastOnError: false,
  });
  const organization = useOrganization();
  const knowledgeBaseUsages = params.keyId
    ? knowledgeBaseUsagesOf(organization.data, params.keyId)
    : [];
  const mappedVirtualKeys = virtualKeys.data?.data ?? [];
  const mappedOauthClients = oauthClients.data?.data ?? [];
  const isLoading =
    enabled &&
    (virtualKeys.isPending || oauthClients.isPending || organization.isPending);
  // Settings that could not be read name no knowledge base job, which is not
  // the same as none being set to this key.
  const known =
    enabled &&
    !isLoading &&
    !virtualKeys.isError &&
    !oauthClients.isError &&
    !organization.isError;
  return {
    virtualKeys: mappedVirtualKeys,
    oauthClients: mappedOauthClients,
    knowledgeBaseUsages,
    isLoading,
    known,
    hasDependents:
      mappedVirtualKeys.some(virtualKeyGoesWithProviderKey) ||
      mappedOauthClients.some(oauthClientGoesWithProviderKey) ||
      knowledgeBaseUsages.length > 0,
  };
}

export function DeleteApiKeyDescription({
  apiKey,
  isSubscription,
  knowledgeBaseUsages,
  virtualKeys,
  oauthClients,
  isLoading,
}: {
  apiKey: { id: string; name: string } | null;
  isSubscription: boolean;
  /** Knowledge base jobs ("embedding", "OCR") configured with this key. */
  knowledgeBaseUsages: string[];
  virtualKeys: MappedVirtualKey[];
  oauthClients: MappedOauthClient[];
  isLoading: boolean;
}) {
  if (!apiKey) {
    return null;
  }

  // Credentials that mapped only this key are deleted with it; the rest keep
  // their other providers and need no notice. The lists come from what the
  // dialog fetched, which covers what a key maps in practice.
  const deletedVirtualKeys = virtualKeys.filter(virtualKeyGoesWithProviderKey);
  const deletedOauthClients = oauthClients.filter(
    oauthClientGoesWithProviderKey,
  );
  const sentences = [
    deletionSentence({
      virtualKeys: deletedVirtualKeys.length,
      oauthClients: deletedOauthClients.length,
    }),
    knowledgeBaseSentence(knowledgeBaseUsages),
  ].filter((sentence) => sentence !== "");

  if (sentences.length === 0 && !isLoading) {
    // Distinct keys: the two branches share a tag, so without them React would
    // reconcile the element in place and remove its bare text nodes, which
    // crashes a machine-translated page.
    return isSubscription ? (
      <span key="disconnect">
        Disconnect "{apiKey.name}"? Anything using it stops working until you
        sign in again.
      </span>
    ) : (
      <span key="delete">
        Are you sure you want to delete "{apiKey.name}"? This action cannot be
        undone.
      </span>
    );
  }

  const lead = [...sentences, isSubscription ? "" : "This cannot be undone."]
    .filter((sentence) => sentence !== "")
    .join(" ");
  const shownVirtualKeys = deletedVirtualKeys.slice(0, 5);
  const moreVirtualKeys = deletedVirtualKeys.length - shownVirtualKeys.length;
  const shownOauthClients = deletedOauthClients.slice(0, 5);
  const moreOauthClients =
    deletedOauthClients.length - shownOauthClients.length;

  return (
    <div className="space-y-4 text-sm">
      <p>
        <span>{lead}</span>
      </p>

      {isLoading && (
        <p className="text-muted-foreground">Checking credential mappings...</p>
      )}

      {shownVirtualKeys.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium">Virtual API keys</p>
            <Link
              className="text-primary underline-offset-4 hover:underline"
              href={`/llm/proxy/virtual-keys?providerApiKeyId=${apiKey.id}`}
            >
              View all
            </Link>
          </div>
          <ul className="space-y-2">
            {shownVirtualKeys.map((key) => (
              <li
                key={key.id}
                className="rounded-md border bg-muted/30 px-3 py-2"
              >
                <div className="font-medium">{key.name}</div>
                <div className="text-muted-foreground">
                  Token starts with {key.tokenStart}...
                </div>
              </li>
            ))}
          </ul>
          {moreVirtualKeys > 0 && (
            <p className="text-muted-foreground">
              <span>{`${moreVirtualKeys} more will be deleted.`}</span>
            </p>
          )}
        </div>
      )}
      {shownOauthClients.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium">OAuth clients</p>
            <SettingsLink
              className="text-primary underline-offset-4 hover:underline"
              href={`/settings/oauth-clients?type=llm&providerApiKeyId=${apiKey.id}`}
              fallback={null}
            >
              View all
            </SettingsLink>
          </div>
          <ul className="space-y-2">
            {shownOauthClients.map((client) => (
              <li
                key={client.id}
                className="rounded-md border bg-muted/30 px-3 py-2"
              >
                <div className="font-medium">{client.name}</div>
                <div className="break-all text-muted-foreground">
                  {client.clientId}
                </div>
              </li>
            ))}
          </ul>
          {moreOauthClients > 0 && (
            <p className="text-muted-foreground">
              <span>{`${moreOauthClients} more will be deleted.`}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

type MappedVirtualKey =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];
type MappedOauthClient =
  archestraApiTypes.GetOauthClientsResponses["200"]["data"][number];

/** True when nothing is left to route to once this provider key is gone. */
function virtualKeyGoesWithProviderKey(key: MappedVirtualKey): boolean {
  return !key.includeFutureProviders && key.providerApiKeys.length <= 1;
}

function oauthClientGoesWithProviderKey(client: MappedOauthClient): boolean {
  return !client.includeFutureProviders && client.providerApiKeys.length <= 1;
}

function deletionSentence(params: {
  virtualKeys: number;
  oauthClients: number;
}): string {
  const parts: string[] = [];
  if (params.virtualKeys === 1) parts.push("virtual key");
  if (params.virtualKeys > 1) parts.push(`${params.virtualKeys} virtual keys`);
  if (params.oauthClients === 1) parts.push("OAuth client");
  if (params.oauthClients > 1) {
    parts.push(`${params.oauthClients} OAuth clients`);
  }
  if (parts.length === 0) return "";
  return `The ${parts.join(" and ")} below will be deleted too.`;
}

function knowledgeBaseSentence(usages: string[]): string {
  if (usages.length === 0) return "";
  const jobs = usages.join(" and ");
  const label = jobs.charAt(0).toUpperCase() + jobs.slice(1);
  return `${label} for knowledge bases ${usages.length === 1 ? "stops" : "stop"} until you choose another key in Settings → Knowledge.`;
}

export function knowledgeBaseUsagesOf(
  organization:
    | {
        embeddingChatApiKeyId?: string | null;
        rerankerChatApiKeyId?: string | null;
        ocrChatApiKeyId?: string | null;
      }
    | null
    | undefined,
  keyId: string,
): string[] {
  if (!organization) return [];
  const usages: string[] = [];
  if (organization.embeddingChatApiKeyId === keyId) usages.push("embedding");
  if (organization.rerankerChatApiKeyId === keyId) usages.push("reranking");
  if (organization.ocrChatApiKeyId === keyId) usages.push("OCR");
  return usages;
}
