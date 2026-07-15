"use client";

import {
  providerDisplayNames,
  providerRequiresPerUserCredential,
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { CodeText } from "@/components/code-text";
import { ProviderIcon } from "@/components/provider-icon";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SingleSelectCombobox } from "@/components/ui/single-select-combobox";
import { Switch } from "@/components/ui/switch";
import { useProfiles } from "@/lib/agent.query";
import config from "@/lib/config/config";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useOrganization,
  useUpdateConnectionSettings,
} from "@/lib/organization.query";
import { ClientIcon } from "./client-icon";
import { CONNECT_CLIENTS } from "./clients";
import {
  applyDefaultBaseUrl,
  applyVisibility,
  buildBaseUrlMeta,
  collapseBaseUrlMeta,
  resolveDefaultBaseUrl,
} from "./connection-base-urls.utils";
import { getShownProviders } from "./connection-flow.utils";

const DEFAULT_VALUE = "__default__";
// "Any client" is always visible on the connection page; admins cannot hide it.
const FILTERABLE_CLIENTS = CONNECT_CLIENTS.filter((c) => c.id !== "generic");
const ALL_CLIENT_IDS = FILTERABLE_CLIENTS.map((c) => c.id);
const ALL_PROVIDER_IDS = [...SupportedProviders] as SupportedProvider[];
const NO_DEFAULT_URL = "__none__";

export function ConnectSettingsSection() {
  const { data: organization } = useOrganization();
  const { data: mcpGateways } = useProfiles({
    filters: { agentTypes: ["profile", "mcp_gateway"] },
  });
  const { data: llmProxies } = useProfiles({
    filters: { agentTypes: ["profile", "llm_proxy"] },
  });

  const [gatewayId, setGatewayId] = useState<string | null>(null);
  const [proxyId, setProxyId] = useState<string | null>(null);
  const [defaultClientId, setDefaultClientId] = useState<string | null>(null);
  // UI stores the set of visible clients/providers; null in DB = show all.
  const [shownClientIds, setShownClientIds] =
    useState<string[]>(ALL_CLIENT_IDS);
  const [shownProviders, setShownProviders] =
    useState<SupportedProvider[]>(ALL_PROVIDER_IDS);
  const [baseUrlMeta, setBaseUrlMeta] = useState<
    Record<
      string,
      { description: string; isDefault: boolean; visible: boolean }
    >
  >({});
  // provider → provider API key id used by auto-provisioned setup virtual keys
  const [defaultProviderKeys, setDefaultProviderKeys] = useState<
    Record<string, string>
  >({});
  const { data: providerApiKeys } = useLlmProviderApiKeys();

  // Env-configured candidate URLs the admin can curate. Keep order stable so
  // the UI mirrors what end users see in the dropdowns elsewhere.
  const envBaseUrls = useMemo(() => config.api.externalProxyUrls, []);

  useEffect(() => {
    if (!organization) return;
    setGatewayId(organization.connectionDefaultMcpGatewayId ?? null);
    setProxyId(organization.connectionDefaultLlmProxyId ?? null);
    setDefaultClientId(organization.connectionDefaultClientId ?? null);
    setShownClientIds(organization.connectionShownClientIds ?? ALL_CLIENT_IDS);
    setShownProviders(getShownProviders(organization) ?? ALL_PROVIDER_IDS);
    setBaseUrlMeta(buildBaseUrlMeta(organization.connectionBaseUrls ?? null));
    setDefaultProviderKeys(
      (organization.connectionDefaultProviderKeys ?? {}) as Record<
        string,
        string
      >,
    );
  }, [organization]);

  const updateMutation = useUpdateConnectionSettings(
    "Connection settings updated",
    "Failed to update connection settings",
  );

  const serverGatewayId = organization?.connectionDefaultMcpGatewayId ?? null;
  const serverProxyId = organization?.connectionDefaultLlmProxyId ?? null;
  const serverDefaultClientId = organization?.connectionDefaultClientId ?? null;
  const serverShownClients = (
    organization?.connectionShownClientIds ?? ALL_CLIENT_IDS
  )
    .slice()
    .sort();
  const serverShownProviders = (
    getShownProviders(organization) ?? ALL_PROVIDER_IDS
  )
    .slice()
    .sort();
  const serverBaseUrlMeta = useMemo(
    () => buildBaseUrlMeta(organization?.connectionBaseUrls ?? null),
    [organization?.connectionBaseUrls],
  );

  const baseUrlsDirty = useMemo(
    () =>
      envBaseUrls.some((url) => {
        const cur = baseUrlMeta[url];
        const prev = serverBaseUrlMeta[url];
        return (
          (cur?.description ?? "") !== (prev?.description ?? "") ||
          (cur?.isDefault ?? false) !== (prev?.isDefault ?? false) ||
          (cur?.visible ?? true) !== (prev?.visible ?? true)
        );
      }),
    [baseUrlMeta, serverBaseUrlMeta, envBaseUrls],
  );

  const serverDefaultProviderKeys =
    (organization?.connectionDefaultProviderKeys ?? {}) as Record<
      string,
      string
    >;

  const hasChanges =
    JSON.stringify(defaultProviderKeys) !==
      JSON.stringify(serverDefaultProviderKeys) ||
    gatewayId !== serverGatewayId ||
    proxyId !== serverProxyId ||
    defaultClientId !== serverDefaultClientId ||
    JSON.stringify([...shownClientIds].sort()) !==
      JSON.stringify(serverShownClients) ||
    JSON.stringify([...shownProviders].sort()) !==
      JSON.stringify(serverShownProviders) ||
    baseUrlsDirty;

  // Collapse "all selected" back to null so future clients/providers are
  // visible by default (null = show all).
  const collapseIfAll = <T,>(selected: T[], all: readonly T[]): T[] | null =>
    selected.length === all.length && all.every((v) => selected.includes(v))
      ? null
      : selected;

  const handleSave = () => {
    updateMutation.mutate({
      connectionDefaultMcpGatewayId: gatewayId,
      connectionDefaultLlmProxyId: proxyId,
      connectionDefaultClientId: defaultClientId,
      connectionShownClientIds: collapseIfAll(shownClientIds, ALL_CLIENT_IDS),
      connectionShownProviders: collapseIfAll(shownProviders, ALL_PROVIDER_IDS),
      connectionBaseUrls: collapseBaseUrlMeta(envBaseUrls, baseUrlMeta),
      connectionDefaultProviderKeys:
        Object.keys(defaultProviderKeys).length > 0
          ? defaultProviderKeys
          : null,
    });
  };

  const handleCancel = () => {
    setGatewayId(serverGatewayId);
    setProxyId(serverProxyId);
    setDefaultClientId(serverDefaultClientId);
    setShownClientIds(serverShownClients);
    setShownProviders(serverShownProviders);
    setBaseUrlMeta(serverBaseUrlMeta);
    setDefaultProviderKeys(serverDefaultProviderKeys);
  };

  const setBaseUrlDescription = (url: string, description: string) =>
    setBaseUrlMeta((prev) => ({
      ...prev,
      [url]: {
        ...(prev[url] ?? { isDefault: false, description: "", visible: true }),
        description,
      },
    }));

  const setBaseUrlVisible = (url: string, visible: boolean) =>
    setBaseUrlMeta((prev) => applyVisibility(prev, url, visible));

  const setDefaultBaseUrl = (selected: string) =>
    setBaseUrlMeta((prev) => applyDefaultBaseUrl(envBaseUrls, prev, selected));

  const currentDefaultUrl = resolveDefaultBaseUrl(envBaseUrls, baseUrlMeta);

  const gatewayItems = mcpGateways ?? [];
  const proxyItems = llmProxies ?? [];

  const providerKeysByProvider = useMemo(() => {
    const grouped = new Map<string, { id: string; name: string }[]>();
    for (const key of providerApiKeys ?? []) {
      const list = grouped.get(key.provider) ?? [];
      list.push({ id: key.id, name: key.name });
      grouped.set(key.provider, list);
    }
    return grouped;
  }, [providerApiKeys]);

  return (
    <WithPermissions
      permissions={{ organizationSettings: ["update"] }}
      noPermissionHandle="tooltip"
    >
      {({ hasPermission }) => {
        const locked = updateMutation.isPending || !hasPermission;
        return (
          <>
            <DialogBody className="flex flex-col gap-6 py-5">
              <SettingRow
                title="Default MCP Gateway"
                description="Pre-selected for everyone; users can still switch."
              >
                <AgentSelector
                  mode="single"
                  flat
                  className="w-60"
                  agents={gatewayItems}
                  value={gatewayId ?? DEFAULT_VALUE}
                  onValueChange={(value) =>
                    setGatewayId(value === DEFAULT_VALUE ? null : value)
                  }
                  personalDefaultOption={{
                    value: DEFAULT_VALUE,
                    label: "Each user personal",
                  }}
                  searchPlaceholder="Search gateways…"
                  disabled={locked}
                />
              </SettingRow>

              <SettingRow
                title="Default LLM Proxy"
                description="Pre-selected for everyone; users can still switch."
              >
                <AgentSelector
                  mode="single"
                  flat
                  className="w-60"
                  agents={proxyItems.filter((p) => !p.isDefault)}
                  value={proxyId ?? DEFAULT_VALUE}
                  onValueChange={(value) =>
                    setProxyId(value === DEFAULT_VALUE ? null : value)
                  }
                  personalDefaultOption={{
                    value: DEFAULT_VALUE,
                    label: "Each user personal",
                  }}
                  searchPlaceholder="Search proxies…"
                  disabled={locked}
                />
              </SettingRow>

              <SettingRow
                title="Default client"
                description="Pre-selected client tile."
              >
                <SingleSelectCombobox
                  className="w-60"
                  value={defaultClientId ?? "none"}
                  onChange={(value) =>
                    setDefaultClientId(value === "none" ? null : value)
                  }
                  options={[
                    { value: "none", label: "Not selected" },
                    ...CONNECT_CLIENTS.map((c) => ({
                      value: c.id,
                      label: c.label,
                      icon: <ClientIcon client={c} size={18} />,
                    })),
                  ]}
                  searchPlaceholder="Search clients…"
                  disabled={locked}
                />
              </SettingRow>

              <SettingSection
                title="Default provider keys for setup commands"
                description="Which provider API key a setup command's virtual key maps to. Automatic falls back to the user's own key resolution (personal, then team, then organization)."
              >
                {providerKeysByProvider.size === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No provider API keys configured yet. Add one under{" "}
                    <Link href="/settings/llm" className="underline">
                      LLM provider keys
                    </Link>{" "}
                    to set a default.
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {[...providerKeysByProvider.entries()].map(
                      ([provider, keys]) => {
                        // Per-user providers (GitHub Copilot) can't have a
                        // shared default — each user connects their own account
                        // at setup time (and the backend rejects such a default
                        // on save). Show the row read-only so it's discoverable
                        // and explained rather than silently missing.
                        const isPerUser = providerRequiresPerUserCredential(
                          provider as SupportedProvider,
                        );
                        return (
                          <div
                            key={provider}
                            className="grid grid-cols-[minmax(0,1fr)_240px] items-center gap-3"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <ProviderIcon
                                provider={provider as SupportedProvider}
                              />
                              <span className="truncate text-sm">
                                {providerDisplayNames[
                                  provider as SupportedProvider
                                ] ?? provider}
                              </span>
                            </div>
                            {isPerUser ? (
                              <span className="text-xs text-muted-foreground">
                                Per-user — each user connects their own account
                              </span>
                            ) : (
                              <SingleSelectCombobox
                                className="w-full"
                                value={
                                  defaultProviderKeys[provider] ?? DEFAULT_VALUE
                                }
                                onChange={(value) =>
                                  setDefaultProviderKeys((prev) => {
                                    const next = { ...prev };
                                    if (value === DEFAULT_VALUE) {
                                      delete next[provider];
                                    } else {
                                      next[provider] = value;
                                    }
                                    return next;
                                  })
                                }
                                options={[
                                  { value: DEFAULT_VALUE, label: "Automatic" },
                                  ...keys.map((key) => ({
                                    value: key.id,
                                    label: key.name,
                                  })),
                                ]}
                                searchPlaceholder="Search keys…"
                                disabled={locked}
                              />
                            )}
                          </div>
                        );
                      },
                    )}
                  </div>
                )}
              </SettingSection>

              {envBaseUrls.length > 1 && (
                <SettingSection
                  title="Connection base URLs"
                  description={
                    <>
                      Every URL from{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]">
                        NEXT_PUBLIC_ARCHESTRA_API_BASE_URL
                      </code>{" "}
                      can reach this deployment. Describe each one, hide it, or
                      mark it as the pre-selected default.
                    </>
                  }
                >
                  <RadioGroup
                    value={currentDefaultUrl ?? NO_DEFAULT_URL}
                    onValueChange={setDefaultBaseUrl}
                    disabled={locked}
                    className="gap-2.5"
                  >
                    {envBaseUrls.map((url) => {
                      const meta = baseUrlMeta[url] ?? {
                        description: "",
                        isDefault: false,
                        visible: true,
                      };
                      const inputId = `base-url-desc-${url}`;
                      const visibleId = `base-url-visible-${url}`;
                      return (
                        <div
                          key={url}
                          className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-lg border bg-card/40 p-3 transition-colors data-[default=true]:border-primary/60 data-[default=true]:bg-primary/[0.04] data-[hidden=true]:opacity-60"
                          data-default={meta.isDefault}
                          data-hidden={!meta.visible}
                        >
                          <RadioGroupItem
                            value={url}
                            id={`base-url-default-${url}`}
                            aria-label={`Make ${url} the default`}
                            disabled={!meta.visible || locked}
                            className="mt-1"
                          />
                          <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <CodeText className="block min-w-0 max-w-full truncate text-[12.5px]">
                                {url}
                              </CodeText>
                              <Label
                                htmlFor={visibleId}
                                className="flex shrink-0 items-center gap-2 text-[11.5px] font-medium text-muted-foreground"
                              >
                                <Switch
                                  id={visibleId}
                                  checked={meta.visible}
                                  onCheckedChange={(checked) =>
                                    setBaseUrlVisible(url, checked)
                                  }
                                  disabled={locked}
                                />
                                Show on Connect page
                              </Label>
                            </div>
                            <Input
                              id={inputId}
                              aria-label="URL description"
                              value={meta.description}
                              onChange={(e) =>
                                setBaseUrlDescription(url, e.target.value)
                              }
                              placeholder="Describe when to use this URL (e.g. internal VPN only)"
                              maxLength={500}
                              disabled={locked}
                              className="text-sm"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </RadioGroup>
                </SettingSection>
              )}

              <SettingSection
                title="Visible clients"
                description="Which clients are offered. “Any client” is always shown."
              >
                <MultiSelectCombobox
                  options={FILTERABLE_CLIENTS.map((c) => ({
                    value: c.id,
                    label: c.label,
                    icon: <ClientIcon client={c} size={18} />,
                  }))}
                  value={shownClientIds}
                  onChange={setShownClientIds}
                  placeholder="Select clients…"
                  emptyMessage="No clients found."
                  disabled={locked}
                />
              </SettingSection>

              <SettingSection
                title="Visible providers"
                description="Which LLM providers are offered."
              >
                <MultiSelectCombobox
                  options={ALL_PROVIDER_IDS.map((p) => ({
                    value: p,
                    label: providerDisplayNames[p],
                    icon: <ProviderIcon provider={p} size={18} />,
                  }))}
                  value={shownProviders}
                  onChange={(values) =>
                    setShownProviders(values as SupportedProvider[])
                  }
                  placeholder="Select providers…"
                  emptyMessage="No providers found."
                  disabled={locked}
                />
              </SettingSection>
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={handleCancel}
                disabled={!hasChanges || updateMutation.isPending}
              >
                Reset
              </Button>
              <Button
                onClick={handleSave}
                disabled={!hasChanges || locked}
                data-testid="connect-settings-save"
              >
                {updateMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </>
        );
      }}
    </WithPermissions>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

/** Compact dialog row: label + description left, a single control right. */
function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-[13px] text-muted-foreground">
          {description}
        </div>
      </div>
      {children}
    </div>
  );
}

/** Full-width dialog section: header on top, content below. */
function SettingSection({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mb-3 mt-0.5 text-[13px] text-muted-foreground">
        {description}
      </div>
      {children}
    </div>
  );
}
