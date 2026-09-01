"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WizardStep } from "@/components/wizard-step";
import config from "@/lib/config/config";
import {
  type CreateConnectionSetupResult,
  useCreateConnectionSetup,
} from "@/lib/connection-setup.query";
import { useOrganization } from "@/lib/organization.query";
import type { PluginDetail, PluginListItem } from "@/lib/plugins/plugin.query";
import {
  type ConnectionBaseUrl,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "../../connection/connection-flow.utils";
import {
  type ConnectPlatformOption,
  detectPlatform,
  platformLabels,
  toPlatformOption,
} from "../../connection/platform.utils";
import { ConnectionPlatformSelect } from "../../connection/platform-select";
import { SetupCommandLine } from "../../connection/setup-command-line";
import { SetupSummaryRow } from "../../connection/setup-summary-row";
import {
  CLIENT_LABELS,
  resolvePluginInstallSelection,
} from "./plugin-page-config";

type InstallablePlugin = Pick<
  PluginDetail | PluginListItem,
  "id" | "displayName" | "clientType" | "supportedPlatforms"
>;

export function PluginInstallDialog({
  plugins,
  open,
  onOpenChange,
}: {
  plugins: readonly InstallablePlugin[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: organization, isPending: organizationPending } =
    useOrganization(open);
  const { mutateAsync: createSetup, isPending: setupPending } =
    useCreateConnectionSetup();
  const compatibility = resolvePluginInstallSelection(plugins);
  const clientType = compatibility.clientType ?? "claude-code";
  const pluginIdsKey = plugins.map((plugin) => plugin.id).join(",");
  const pluginIds = useMemo(
    () => pluginIdsKey.split(",").filter(Boolean),
    [pluginIdsKey],
  );
  const platformKey = compatibility.supportedPlatforms.join(",");
  const platforms = useMemo(
    () =>
      platformKey
        .split(",")
        .filter(Boolean)
        .map((platform) =>
          platform === "windows" ? "windows" : "macos",
        ) satisfies ConnectPlatformOption[],
    [platformKey],
  );
  const [platform, setPlatform] = useState<ConnectPlatformOption>(platforms[0]);
  const [platformDetected, setPlatformDetected] = useState(false);
  const [selectedBaseUrl, setSelectedBaseUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState<"platform" | "endpoint" | null>(null);
  const [result, setResult] = useState<CreateConnectionSetupResult | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const baseUrls = useMemo(
    () =>
      resolveCandidateBaseUrls({
        externalProxyUrls: config.api.externalProxyUrls,
        internalProxyUrl: config.api.internalProxyUrl,
        metadata: organization?.connectionBaseUrls as
          | ConnectionBaseUrl[]
          | null
          | undefined,
      }),
    [organization?.connectionBaseUrls],
  );
  const defaultBaseUrl =
    resolveAdminDefaultBaseUrl(
      organization?.connectionBaseUrls as
        | ConnectionBaseUrl[]
        | null
        | undefined,
    ) ?? baseUrls[0];
  const baseUrl =
    selectedBaseUrl && baseUrls.includes(selectedBaseUrl)
      ? selectedBaseUrl
      : defaultBaseUrl;

  useEffect(() => {
    const detected = toPlatformOption(detectPlatform());
    setPlatform(platforms.includes(detected) ? detected : platforms[0]);
    setPlatformDetected(true);
  }, [platforms]);

  const generate = useCallback(async () => {
    if (!baseUrl) return;
    setResult(null);
    setFailed(false);
    const created = await createSetup({
      clientId: clientType,
      platform,
      baseUrl,
      pluginIds,
    });
    setResult(created);
    setFailed(!created);
  }, [baseUrl, clientType, createSetup, platform, pluginIds]);

  useEffect(() => {
    if (!open || !platformDetected || organizationPending || !baseUrl) return;
    void generate();
  }, [baseUrl, generate, open, organizationPending, platformDetected]);

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        plugins.length === 1
          ? `Install ${plugins[0]?.displayName}`
          : `Install ${plugins.length} plugins`
      }
      description="Review the target, then run the setup command."
      size="medium"
      className="sm:max-w-5xl"
      bodyClassName="overflow-y-auto"
    >
      <div className="space-y-5">
        <WizardStep n={1} title="Review the setup">
          <ul className="grid gap-2">
            <SetupSummaryRow>
              Install{" "}
              <span className="font-medium">
                {plugins.length === 1
                  ? plugins[0]?.displayName
                  : `${plugins.length} plugins`}
              </span>{" "}
              in {CLIENT_LABELS[clientType]}
            </SetupSummaryRow>
            {plugins.length > 1 && (
              <SetupSummaryRow
                detail={plugins.map((plugin) => plugin.displayName).join(", ")}
              >
                Include the selected plugins
              </SetupSummaryRow>
            )}
            <SetupSummaryRow
              editable={platforms.length > 1}
              isEditing={editing === "platform"}
              onToggle={() =>
                setEditing((current) =>
                  current === "platform" ? null : "platform",
                )
              }
              editor={
                platforms.length > 1 ? (
                  <ConnectionPlatformSelect
                    value={platform}
                    onValueChange={setPlatform}
                    options={platforms}
                    ariaLabel="Target platform"
                    className="w-full"
                  />
                ) : undefined
              }
            >
              Run on{" "}
              <span className="font-medium text-foreground">
                {platformLabels[platform]}
              </span>
            </SetupSummaryRow>
            {baseUrls.length > 1 && (
              <SetupSummaryRow
                editable
                isEditing={editing === "endpoint"}
                onToggle={() =>
                  setEditing((current) =>
                    current === "endpoint" ? null : "endpoint",
                  )
                }
                editor={
                  <Select value={baseUrl} onValueChange={setSelectedBaseUrl}>
                    <SelectTrigger className="w-full" aria-label="Endpoint">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {baseUrls.map((url) => (
                        <SelectItem key={url} value={url}>
                          {url}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              >
                Use endpoint <span className="font-medium">{baseUrl}</span>
              </SetupSummaryRow>
            )}
          </ul>
        </WizardStep>

        <WizardStep n={2} title="Run the setup script" last>
          <div className="flex flex-col gap-3">
            <output className="sr-only" aria-live="polite">
              {failed
                ? "Setup command generation failed"
                : result
                  ? "Setup command ready"
                  : "Generating setup command"}
            </output>
            <div className="overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
              <SetupCommandLine
                command={result?.command ?? null}
                pending={organizationPending || setupPending}
                failed={failed}
                onRetry={generate}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <span className="max-w-2xl">
                The command downloads a one-time setup script (expires in 15
                minutes) and pipes it straight to{" "}
                {platform === "windows" ? "PowerShell" : "Bash"}. It installs
                only {plugins.length === 1 ? "this plugin" : "these plugins"}{" "}
                and leaves proxy and MCP configuration unchanged.
              </span>
              <button
                type="button"
                onClick={generate}
                disabled={setupPending}
                className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-50"
              >
                <RotateCcw className="size-3" />
                Regenerate
              </button>
            </div>
          </div>
        </WizardStep>
      </div>
    </StandardDialog>
  );
}
