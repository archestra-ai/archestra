"use client";

import {
  providerDisplayNames,
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ClientIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import { getShownProviders } from "@/app/connection/connection-flow.utils";
import { AgentIcon } from "@/components/agent-icon";
import { CodeText } from "@/components/code-text";
import { ProviderIcon } from "@/components/provider-icon";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsCardHeader,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  applyDefaultBaseUrl,
  applyVisibility,
  buildBaseUrlMeta,
  collapseBaseUrlMeta,
  resolveDefaultBaseUrl,
} from "./connection-base-urls.utils";

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
    <SettingsSectionStack>
      <SettingsBlock
        title="Default MCP Gateway"
        description={
          'Control which MCP Gateway is pre-selected on the "Connect" page.'
        }
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <SingleSelectCombobox
                className="w-64"
                value={gatewayId ?? DEFAULT_VALUE}
                onChange={(value) =>
                  setGatewayId(value === DEFAULT_VALUE ? null : value)
                }
                options={[
                  { value: DEFAULT_VALUE, label: "Each user personal" },
                  ...gatewayItems.map((g) => ({
                    value: g.id,
                    label: g.name,
                    icon: (
                      <AgentIcon
                        icon={g.icon}
                        fallbackType="mcp_gateway"
                        size={16}
                      />
                    ),
                  })),
                ]}
                searchPlaceholder="Search gateways…"
                disabled={updateMutation.isPending || !hasPermission}
              />
            )}
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="Default LLM Proxy"
        description={
          'Control which LLM Proxy is pre-selected on the "Connect" page.'
        }
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <SingleSelectCombobox
                className="w-64"
                value={proxyId ?? DEFAULT_VALUE}
                onChange={(value) =>
                  setProxyId(value === DEFAULT_VALUE ? null : value)
                }
                options={[
                  { value: DEFAULT_VALUE, label: "Each user personal" },
                  ...proxyItems
                    .filter((p) => !p.isDefault)
                    .map((p) => ({
                      value: p.id,
                      label: p.name,
                      icon: (
                        <AgentIcon
                          icon={p.icon}
                          fallbackType="llm_proxy"
                          size={16}
                        />
                      ),
                    })),
                ]}
                searchPlaceholder="Search proxies…"
                disabled={updateMutation.isPending || !hasPermission}
              />
            )}
          </WithPermissions>
        }
      />
      <Card>
        <SettingsCardHeader
          title="Default provider keys for setup commands"
          description="When a user generates a one-command setup on the Connect page and chooses a virtual key, this controls which provider API key it maps to. Providers left on Automatic fall back to the user's own key resolution (personal, then team, then organization)."
        />
        <CardContent>
          {providerKeysByProvider.size === 0 ? (
            <p className="text-sm text-muted-foreground">
              No provider API keys configured yet. Add one under{" "}
              <Link href="/settings/llm" className="underline">
                LLM provider keys
              </Link>{" "}
              to set a default.
            </p>
          ) : (
            <WithPermissions
              permissions={{ organizationSettings: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div className="grid gap-2.5">
                  {[...providerKeysByProvider.entries()].map(
                    ([provider, keys]) => (
                      <div
                        key={provider}
                        className="grid grid-cols-[minmax(0,1fr)_240px] items-center gap-3 rounded-lg border bg-card/40 p-3"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <ProviderIcon
                            provider={provider as SupportedProvider}
                          />
                          <span className="truncate text-sm font-medium">
                            {providerDisplayNames[
                              provider as SupportedProvider
                            ] ?? provider}
                          </span>
                        </div>
                        <SingleSelectCombobox
                          className="w-full"
                          value={defaultProviderKeys[provider] ?? DEFAULT_VALUE}
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
                          disabled={updateMutation.isPending || !hasPermission}
                        />
                      </div>
                    ),
                  )}
                </div>
              )}
            </WithPermissions>
          )}
        </CardContent>
      </Card>
      <SettingsBlock
        title="Default client"
        description={
          'Control which client is pre-selected on the "Connect" page.'
        }
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <SingleSelectCombobox
                className="w-64"
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
                disabled={updateMutation.isPending || !hasPermission}
              />
            )}
          </WithPermissions>
        }
      />
      <WithPermissions
        permissions={{ organizationSettings: ["update"] }}
        noPermissionHandle="tooltip"
      >
        {({ hasPermission }) => (
          <>
            {envBaseUrls.length > 1 && (
              <Card>
                <SettingsCardHeader
                  title="Connection base URLs"
                  description={
                    <>
                      These URLs come from{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]">
                        NEXT_PUBLIC_ARCHESTRA_API_BASE_URL
                      </code>{" "}
                      — every one of them can be used to reach Archestra. For
                      each endpoint you can:
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        <li>
                          Add a description so members understand when to use it
                          (e.g. office network only, public internet, EU
                          region).
                        </li>
                        <li>
                          Hide it from the Connect page if it shouldn't be
                          surfaced to end users.
                        </li>
                        <li>
                          Mark one as default — that one is pre-selected on the
                          Connect page.
                        </li>
                      </ul>
                    </>
                  }
                />
                <CardContent>
                  <RadioGroup
                    value={currentDefaultUrl ?? NO_DEFAULT_URL}
                    onValueChange={setDefaultBaseUrl}
                    disabled={updateMutation.isPending || !hasPermission}
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
                            disabled={
                              !meta.visible ||
                              updateMutation.isPending ||
                              !hasPermission
                            }
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
                                  disabled={
                                    updateMutation.isPending || !hasPermission
                                  }
                                />
                                Show on Connect page
                              </Label>
                            </div>
                            <Input
                              id={inputId}
                              value={meta.description}
                              onChange={(e) =>
                                setBaseUrlDescription(url, e.target.value)
                              }
                              placeholder="Describe when to use this URL (e.g. internal VPN only)"
                              maxLength={500}
                              disabled={
                                updateMutation.isPending || !hasPermission
                              }
                              className="text-sm"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </RadioGroup>
                </CardContent>
              </Card>
            )}
            <Card>
              <SettingsCardHeader
                title="Visible clients"
                description={
                  'Control which clients are available on the "Connect" page.'
                }
              />
              <CardContent>
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
                  disabled={updateMutation.isPending || !hasPermission}
                />
              </CardContent>
            </Card>
            <Card>
              <SettingsCardHeader
                title="Visible providers"
                description={
                  'Control which providers are available on the "Connect" page.'
                }
              />
              <CardContent>
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
                  disabled={updateMutation.isPending || !hasPermission}
                />
              </CardContent>
            </Card>
          </>
        )}
      </WithPermissions>
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </SettingsSectionStack>
  );
}
