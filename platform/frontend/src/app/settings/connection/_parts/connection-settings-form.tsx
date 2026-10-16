"use client";

import {
  defaultRuntimeHandoffInstructions,
  providerRequiresPerUserCredential,
  resolveRuntimeHandoffInstructions,
} from "@archestra/shared";
import { INSTALLER_CLIENT_IDS } from "@archestra/shared/connection-setup";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ClientIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS, orderedClients } from "@/app/connection/clients";
import {
  applyDefaultBaseUrl,
  applyVisibility,
  buildBaseUrlMeta,
  collapseBaseUrlMeta,
  resolveDefaultBaseUrl,
} from "@/app/connection/connection-base-urls.utils";
import { AgentSelector } from "@/components/agent-selector";
import { CodeText } from "@/components/code-text";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SingleSelectCombobox } from "@/components/ui/single-select-combobox";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgentOptions } from "@/lib/agent.query";
import config from "@/lib/config/config";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useOrganization,
  useUpdateConnectionSettings,
} from "@/lib/organization.query";

import {
  AvailableAgentsList,
  type ClientProviderKeys,
} from "./available-agents-list";

const DEFAULT_VALUE = "__default__";
// "Any client" is always visible on the connection page; admins cannot hide it.
const FILTERABLE_CLIENTS = CONNECT_CLIENTS.filter((c) => c.id !== "generic");
const ALL_CLIENT_IDS = FILTERABLE_CLIENTS.map((c) => c.id);
const DEFAULT_CLIENT_ORDER = [
  ...INSTALLER_CLIENT_IDS,
  ...FILTERABLE_CLIENTS.filter(
    (client) => !INSTALLER_CLIENT_IDS.some((id) => id === client.id),
  )
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((client) => client.id),
];
const NO_DEFAULT_URL = "__none__";

export function ConnectionSettingsForm() {
  const { data: organization } = useOrganization();
  const appName = useAppName();
  const defaultInstructions = defaultRuntimeHandoffInstructions(appName);
  const { data: mcpGateways } = useAgentOptions({
    filters: { agentTypes: ["profile", "mcp_gateway"] },
  });

  const [gatewayId, setGatewayId] = useState<string | null>(null);
  const [defaultClientId, setDefaultClientId] = useState<string | null>(null);
  // UI stores the set of visible clients/providers; null in DB = show all.
  const [shownClientIds, setShownClientIds] =
    useState<string[]>(ALL_CLIENT_IDS);
  const [clientOrder, setClientOrder] =
    useState<string[]>(DEFAULT_CLIENT_ORDER);
  const [baseUrlMeta, setBaseUrlMeta] = useState<
    Record<
      string,
      { description: string; isDefault: boolean; visible: boolean }
    >
  >({});
  // client → provider API keys its setup command's virtual key maps to
  const [clientFutureProviders, setClientFutureProviders] = useState<
    Record<string, boolean>
  >({});
  const [clientProviderKeys, setClientProviderKeys] =
    useState<ClientProviderKeys>({});
  const [skillsEnabled, setSkillsEnabled] = useState(true);
  const [llmProxyEnabled, setLlmProxyEnabled] = useState(true);
  const [pluginsEnabled, setPluginsEnabled] = useState(true);
  const [runtimeHandoffEnabled, setRuntimeHandoffEnabled] = useState(true);
  const [runtimeHandoffInstructions, setRuntimeHandoffInstructions] =
    useState(defaultInstructions);
  const { data: providerApiKeys } = useLlmProviderApiKeys();

  // Env-configured candidate URLs the admin can curate. Keep order stable so
  // the UI mirrors what end users see in the dropdowns elsewhere.
  const envBaseUrls = useMemo(() => config.api.externalProxyUrls, []);

  useEffect(() => {
    if (!organization) return;
    setGatewayId(organization.connectionDefaultMcpGatewayId ?? null);
    setDefaultClientId(organization.connectionDefaultClientId ?? null);
    setShownClientIds(organization.connectionShownClientIds ?? ALL_CLIENT_IDS);
    setClientOrder(
      orderedClients(organization.connectionClientOrder ?? DEFAULT_CLIENT_ORDER)
        .filter((c) => c.id !== "generic")
        .map((c) => c.id),
    );
    setBaseUrlMeta(buildBaseUrlMeta(organization.connectionBaseUrls ?? null));
    setClientProviderKeys(organization.connectionClientProviderKeys ?? {});
    setClientFutureProviders(
      organization.connectionClientFutureProviders ?? {},
    );
    setSkillsEnabled(organization.connectionSkillsEnabled);
    setLlmProxyEnabled(organization.connectionLlmProxyEnabled);
    setPluginsEnabled(organization.connectionPluginsEnabled);
    setRuntimeHandoffEnabled(
      organization.connectionRuntimeHandoffEnabled ?? true,
    );
    setRuntimeHandoffInstructions(
      resolveRuntimeHandoffInstructions({
        stored: organization.connectionRuntimeHandoffInstructions,
        appName,
      }),
    );
  }, [organization, appName]);

  const updateMutation = useUpdateConnectionSettings(
    "Connection settings updated",
    "Failed to update connection settings",
  );

  const serverGatewayId = organization?.connectionDefaultMcpGatewayId ?? null;
  const serverDefaultClientId = organization?.connectionDefaultClientId ?? null;
  const serverShownClients = (
    organization?.connectionShownClientIds ?? ALL_CLIENT_IDS
  )
    .slice()
    .sort();
  const serverClientOrder = orderedClients(
    organization?.connectionClientOrder ?? DEFAULT_CLIENT_ORDER,
  )
    .filter((c) => c.id !== "generic")
    .map((c) => c.id);
  const clientsInOrder = orderedClients(clientOrder).filter(
    (c) => c.id !== "generic",
  );
  const selectedClientOrder = clientsInOrder
    .filter((c) => shownClientIds.includes(c.id))
    .map((c) => c.id);
  const clientOrderDirty =
    JSON.stringify(selectedClientOrder) !==
    JSON.stringify(
      serverClientOrder.filter((id) => serverShownClients.includes(id)),
    );
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

  const serverClientProviderKeys: ClientProviderKeys =
    organization?.connectionClientProviderKeys ?? {};

  const serverSkillsEnabled = organization?.connectionSkillsEnabled ?? true;
  const serverLlmProxyEnabled = organization?.connectionLlmProxyEnabled ?? true;
  const serverPluginsEnabled = organization?.connectionPluginsEnabled ?? true;
  const serverRuntimeHandoffEnabled =
    organization?.connectionRuntimeHandoffEnabled ?? true;
  const serverRuntimeHandoffInstructions = resolveRuntimeHandoffInstructions({
    stored: organization?.connectionRuntimeHandoffInstructions,
    appName,
  });

  const hasChanges =
    JSON.stringify(clientFutureProviders) !==
      JSON.stringify(organization?.connectionClientFutureProviders ?? {}) ||
    JSON.stringify(withoutEmptyClients(clientProviderKeys)) !==
      JSON.stringify(withoutEmptyClients(serverClientProviderKeys)) ||
    gatewayId !== serverGatewayId ||
    defaultClientId !== serverDefaultClientId ||
    JSON.stringify([...shownClientIds].sort()) !==
      JSON.stringify(serverShownClients) ||
    clientOrderDirty ||
    skillsEnabled !== serverSkillsEnabled ||
    llmProxyEnabled !== serverLlmProxyEnabled ||
    runtimeHandoffEnabled !== serverRuntimeHandoffEnabled ||
    runtimeHandoffInstructions !== serverRuntimeHandoffInstructions ||
    pluginsEnabled !== serverPluginsEnabled ||
    baseUrlsDirty;

  // Collapse "all selected" back to null so future clients/providers are
  // visible by default (null = show all).
  const collapseIfAll = <T,>(selected: T[], all: readonly T[]): T[] | null =>
    selected.length === all.length && all.every((v) => selected.includes(v))
      ? null
      : selected;

  const handleSave = () => {
    if (runtimeHandoffEnabled && !runtimeHandoffInstructions.trim()) return;
    updateMutation.mutate({
      connectionDefaultMcpGatewayId: gatewayId,
      connectionDefaultClientId: defaultClientId,
      connectionRuntimeHandoffEnabled: runtimeHandoffEnabled,
      connectionRuntimeHandoffInstructions:
        !runtimeHandoffInstructions.trim() ||
        runtimeHandoffInstructions.trim() === defaultInstructions
          ? null
          : runtimeHandoffInstructions.trim(),
      connectionShownClientIds: collapseIfAll(shownClientIds, ALL_CLIENT_IDS),
      ...(clientOrderDirty
        ? { connectionClientOrder: selectedClientOrder }
        : {}),
      connectionBaseUrls: collapseBaseUrlMeta(envBaseUrls, baseUrlMeta),
      connectionClientFutureProviders: clientFutureProviders,
      connectionClientProviderKeys: withoutEmptyClients(clientProviderKeys),
      ...(skillsEnabled !== serverSkillsEnabled
        ? { connectionSkillsEnabled: skillsEnabled }
        : {}),
      ...(llmProxyEnabled !== serverLlmProxyEnabled
        ? { connectionLlmProxyEnabled: llmProxyEnabled }
        : {}),
      ...(pluginsEnabled !== serverPluginsEnabled
        ? { connectionPluginsEnabled: pluginsEnabled }
        : {}),
    });
  };

  const handleCancel = () => {
    setGatewayId(serverGatewayId);
    setDefaultClientId(serverDefaultClientId);
    setShownClientIds(serverShownClients);
    setClientOrder(serverClientOrder);
    setBaseUrlMeta(serverBaseUrlMeta);
    setClientProviderKeys(serverClientProviderKeys);
    setSkillsEnabled(serverSkillsEnabled);
    setLlmProxyEnabled(serverLlmProxyEnabled);
    setPluginsEnabled(serverPluginsEnabled);
    setRuntimeHandoffEnabled(serverRuntimeHandoffEnabled);
    setRuntimeHandoffInstructions(serverRuntimeHandoffInstructions);
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

  // One member's personal gateway is no default for everyone; the sentinel
  // already offers each user their own. A saved one stays listed until
  // replaced, so the selector can still name it.
  const gatewayItems = (mcpGateways ?? []).filter(
    (gateway) => !gateway.isPersonalGateway || gateway.id === gatewayId,
  );

  // Per-user providers (GitHub Copilot) can't be mapped: each user connects
  // their own account at setup time, and the backend rejects such a mapping.
  const sharedProviderKeys = useMemo(
    () =>
      (providerApiKeys ?? []).filter(
        (key) => !providerRequiresPerUserCredential(key.provider),
      ),
    [providerApiKeys],
  );

  return (
    <WithPermissions
      permissions={{ organizationSettings: ["update"] }}
      noPermissionHandle="tooltip"
    >
      {({ hasPermission }) => {
        const locked = updateMutation.isPending || !hasPermission;
        return (
          <>
            <SettingsSectionStack>
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
                  sentinelOption={{
                    value: DEFAULT_VALUE,
                    label: "Each user personal",
                  }}
                  searchPlaceholder="Search gateways…"
                  disabled={locked}
                />
              </SettingRow>

              <SettingRow
                title="LLM Proxy on Connect"
                description="Offer routing through the LLM Proxy. Existing client configs keep working."
              >
                <Switch
                  checked={llmProxyEnabled}
                  onCheckedChange={setLlmProxyEnabled}
                  disabled={locked}
                  aria-label="Offer the LLM Proxy on the Connect page"
                />
              </SettingRow>

              <SettingRow
                title="Skills on Connect"
                description="Offer installing shared skills. Existing installs keep working."
              >
                <Switch
                  checked={skillsEnabled}
                  onCheckedChange={setSkillsEnabled}
                  disabled={locked}
                  aria-label="Offer skills on the Connect page"
                />
              </SettingRow>

              <SettingRow
                title="Plugins on Connect"
                description="Offer installing approved plugins. Existing installs keep working."
              >
                <Switch
                  checked={pluginsEnabled}
                  onCheckedChange={setPluginsEnabled}
                  disabled={locked}
                  aria-label="Offer plugins on the Connect page"
                />
              </SettingRow>

              <SettingSection
                title="Agents users can connect"
                description="Pick which agents show on the Connect page and drag to set their order. Click one to choose the model keys it uses."
              >
                <AvailableAgentsList
                  clients={clientsInOrder}
                  shownClientIds={shownClientIds}
                  onShownClientIdsChange={setShownClientIds}
                  onOrderChange={setClientOrder}
                  clientFutureProviders={clientFutureProviders}
                  onClientFutureProvidersChange={(clientId, value) => {
                    setClientFutureProviders((previous) => ({
                      ...previous,
                      [clientId]: value,
                    }));
                    if (value)
                      setClientProviderKeys((previous) => ({
                        ...previous,
                        [clientId]: [],
                      }));
                  }}
                  clientProviderKeys={clientProviderKeys}
                  onClientKeysChange={(clientId, value) =>
                    setClientProviderKeys((prev) => ({
                      ...prev,
                      [clientId]: value,
                    }))
                  }
                  providerApiKeys={sharedProviderKeys}
                  disabled={locked}
                />
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

              <SettingsBlock
                title="Instructions for connected agents"
                description="Added to the system prompt of every agent users connect from the Connect page."
                control={
                  <Switch
                    checked={runtimeHandoffEnabled}
                    onCheckedChange={setRuntimeHandoffEnabled}
                    disabled={locked}
                    aria-label="Enable instructions for connected agents"
                  />
                }
              >
                <div className="space-y-2">
                  <Textarea
                    aria-label="Instructions for connected agents"
                    value={runtimeHandoffInstructions}
                    onChange={(event) =>
                      setRuntimeHandoffInstructions(event.target.value)
                    }
                    rows={2}
                    maxLength={20000}
                    disabled={locked || !runtimeHandoffEnabled}
                    className="font-mono text-xs leading-relaxed"
                  />
                  <div className="flex justify-between gap-4 text-xs text-muted-foreground">
                    <span>
                      Supported agents receive updates on next launch; other
                      clients need setup or manual copying.
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {runtimeHandoffInstructions.length.toLocaleString()} /
                      20,000
                    </span>
                  </div>
                  {runtimeHandoffEnabled &&
                    !runtimeHandoffInstructions.trim() && (
                      <InlineNotice variant="error">
                        Enter instructions.
                      </InlineNotice>
                    )}
                </div>
              </SettingsBlock>
            </SettingsSectionStack>
            <SettingsSaveBar
              hasChanges={hasChanges}
              isSaving={updateMutation.isPending}
              permissions={{ organizationSettings: ["update"] }}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          </>
        );
      }}
    </WithPermissions>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

/**
 * One compact setting whose control sits beside its label.
 */
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
    <SettingsBlock title={title} description={description} control={children} />
  );
}

/** One compact setting whose control needs the full width below its header. */
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
    <SettingsBlock title={title} description={description} control={null}>
      {children}
    </SettingsBlock>
  );
}

/** Drop clients left with no keys, so they read as unset. */
function withoutEmptyClients(
  keys: ClientProviderKeys,
): ClientProviderKeys | null {
  const set = Object.entries(keys).filter(
    ([, mappings]) => mappings && mappings.length > 0,
  );
  return set.length > 0 ? Object.fromEntries(set) : null;
}
