"use client";

import {
  providerDisplayNames,
  type SupportedProvider,
  SupportedProviders,
} from "@shared";
import { useEffect, useState } from "react";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import { getShownProviders } from "@/app/connection/connection-flow.utils";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProfiles } from "@/lib/agent.query";
import {
  useOrganization,
  useUpdateConnectionSettings,
} from "@/lib/organization.query";
import { ComboboxPicker } from "./combobox-picker";

const DEFAULT_VALUE = "__default__";
// "Any client" is always visible on the connection page; admins cannot hide it.
const FILTERABLE_CLIENTS = CONNECT_CLIENTS.filter((c) => c.id !== "generic");
const ALL_CLIENT_IDS = FILTERABLE_CLIENTS.map((c) => c.id);
const ALL_PROVIDER_IDS = [...SupportedProviders] as SupportedProvider[];

export default function ConnectionSettingsPage() {
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

  useEffect(() => {
    if (!organization) return;
    setGatewayId(organization.connectionDefaultMcpGatewayId ?? null);
    setProxyId(organization.connectionDefaultLlmProxyId ?? null);
    setDefaultClientId(organization.connectionDefaultClientId ?? null);
    setShownClientIds(organization.connectionShownClientIds ?? ALL_CLIENT_IDS);
    setShownProviders(getShownProviders(organization) ?? ALL_PROVIDER_IDS);
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

  const hasChanges =
    gatewayId !== serverGatewayId ||
    proxyId !== serverProxyId ||
    defaultClientId !== serverDefaultClientId ||
    JSON.stringify([...shownClientIds].sort()) !==
      JSON.stringify(serverShownClients) ||
    JSON.stringify([...shownProviders].sort()) !==
      JSON.stringify(serverShownProviders);

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
    });
  };

  const handleCancel = () => {
    setGatewayId(serverGatewayId);
    setProxyId(serverProxyId);
    setDefaultClientId(serverDefaultClientId);
    setShownClientIds(serverShownClients);
    setShownProviders(serverShownProviders);
  };

  const gatewayItems = mcpGateways ?? [];
  const proxyItems = llmProxies ?? [];

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Default MCP Gateway"
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={gatewayId ?? DEFAULT_VALUE}
                onValueChange={(value) =>
                  setGatewayId(value === DEFAULT_VALUE ? null : value)
                }
                disabled={updateMutation.isPending || !hasPermission}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Each user personal" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>
                    Each user personal
                  </SelectItem>
                  {gatewayItems.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="Default LLM Proxy"
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={proxyId ?? DEFAULT_VALUE}
                onValueChange={(value) =>
                  setProxyId(value === DEFAULT_VALUE ? null : value)
                }
                disabled={updateMutation.isPending || !hasPermission}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Default LLM Proxy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>
                    Default LLM Proxy
                  </SelectItem>
                  {proxyItems
                    .filter((p) => !p.isDefault)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="Default client"
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={defaultClientId ?? "generic"}
                onValueChange={(value) =>
                  setDefaultClientId(value === "generic" ? null : value)
                }
                disabled={updateMutation.isPending || !hasPermission}
              >
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONNECT_CLIENTS.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            <Card>
              <CardHeader>
                <CardTitle>Visible clients</CardTitle>
              </CardHeader>
              <CardContent>
                <ComboboxPicker
                  items={FILTERABLE_CLIENTS.map((c) => ({
                    value: c.id,
                    label: c.label,
                  }))}
                  value={shownClientIds}
                  onValueChange={setShownClientIds}
                  placeholder="Select clients…"
                  kind="client"
                  disabled={updateMutation.isPending || !hasPermission}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Visible providers</CardTitle>
              </CardHeader>
              <CardContent>
                <ComboboxPicker
                  items={ALL_PROVIDER_IDS.map((p) => ({
                    value: p,
                    label: providerDisplayNames[p],
                  }))}
                  value={shownProviders}
                  onValueChange={(values) =>
                    setShownProviders(values as SupportedProvider[])
                  }
                  placeholder="Select providers…"
                  kind="provider"
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
