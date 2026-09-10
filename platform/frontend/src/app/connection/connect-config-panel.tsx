"use client";

import {
  AlertTriangle,
  Check,
  CircleDashed,
  Download,
  Info,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { AgentSelector } from "@/components/agent-selector";
import {
  type ConnectionCreditWarning,
  CreditWarningNotice,
} from "@/components/connection/credit-warning-notice";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WizardStep } from "@/components/wizard-step";
import {
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import {
  useCreateConnectionPassthroughKey,
  useCreateConnectionVirtualKey,
} from "@/lib/connection-setup.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useCreateSkillShareLink } from "@/lib/skills/skill-share.query";
import {
  buildClaudeDesktopConfigProfile,
  downloadClaudeDesktopConfig,
  generateConfigFilename,
  isClaudeDesktopProfileUrlSupported,
  maskConfigSecrets,
} from "./claude-desktop-config";
import { FINISH_OAUTH_FLOW_TITLE } from "./clients";
import type { ConnectionBaseUrl } from "./connection-flow.utils";
import { GatewayServersSummary } from "./gateway-servers-summary";
import { OsLogos } from "./os-logos";
import {
  type ConnectPlatformOption,
  detectPlatform,
  platformLabels,
  toPlatformOption,
} from "./platform.utils";
import { ConnectionPlatformToggle } from "./platform-select";
import { type ConnectSkill, useAllSkills } from "./skills-marketplace-step";

const EMPTY_SKILLS: ConnectSkill[] = [];

/** Clients whose setup is delivered as a downloadable Archestra config profile. */
export function isConfigClient(clientId: string | null): boolean {
  return clientId === "claude-desktop";
}

interface ConnectConfigPanelProps {
  /** null when the user can't read MCP gateways. */
  mcpGateways: AgentSelectorAgent[] | null;
  mcpGatewayId: string | null;
  onMcpGatewaySelect: (id: string) => void;
  /** Slug of the selected gateway (for the MCP server URL); falls back to its id. */
  gatewaySlug: string | null;
  /** The org's single LLM Proxy id; null when the user can't read it (or it hasn't loaded). */
  llmProxyId: string | null;
  baseUrl: string;
  candidateBaseUrls: readonly string[];
  baseUrlMetadata: readonly ConnectionBaseUrl[] | null | undefined;
  onBaseUrlChange: (url: string) => void;
  /** When false, shared skills are not offered in the profile. */
  skillsEnabled?: boolean;
  /**
   * When false, the profile is MCP-only (no inference keys). Distinct from
   * `llmProxyId === null`, which still means the caller cannot read the proxy.
   */
  llmProxyEnabled?: boolean;
}

/**
 * Claude Desktop's wizard. Mirrors the Claude Code command panel — Review the
 * setup, then a generation step — but instead of a shell command it builds and
 * downloads an Archestra configuration profile the user imports into Claude
 * Desktop's "Configure Third-Party Inference" screen. Anthropic is the only
 * supported provider, and both keys (passthrough + standard virtual) are always
 * provisioned and embedded in the profile.
 */
export function ConnectConfigPanel({
  mcpGateways,
  mcpGatewayId,
  onMcpGatewaySelect,
  gatewaySlug,
  llmProxyId,
  baseUrl,
  candidateBaseUrls,
  baseUrlMetadata,
  onBaseUrlChange,
  skillsEnabled = true,
  llmProxyEnabled = true,
}: ConnectConfigPanelProps) {
  const providerCatalog = useModelProviderCatalog();
  const profileBaseUrlSupported = isClaudeDesktopProfileUrlSupported(baseUrl);
  // Target OS — only used to label the downloaded file; the profile itself is
  // identical across platforms. Auto-detected after mount to avoid a hydration
  // mismatch, overridable in the review step.
  const [platform, setPlatform] = useState<ConnectPlatformOption>("macos");
  useEffect(() => {
    setPlatform(toPlatformOption(detectPlatform()));
  }, []);

  const [editing, setEditing] = useState<EditableRow | null>(null);
  const toggleEdit = (row: EditableRow) =>
    setEditing((cur) => (cur === row ? null : row));

  // Shared skills ride along as a git-backed plugin marketplace baked into the
  // profile, gated on the caller being a skill admin with at least one skill.
  // Whole-org snapshot (no per-skill picker) — users add the marketplace in
  // Claude Desktop, then install its shared-skills plugin bundle.
  const profileAvailability = useConfigProfileAvailability();
  const canPrepareProfile =
    profileBaseUrlSupported &&
    (!llmProxyEnabled ||
      (llmProxyId !== null &&
        profileAvailability.canCreateVirtualKey === true &&
        profileAvailability.anthropicHasKey));
  const { data: skillGrants } = useScopedCapabilities();
  const canAdminSkills = ["read", "use", "manage-permissions"].every((action) =>
    skillGrants?.some(
      (grant) =>
        grant.resource === "skill" &&
        grant.scope === "*" &&
        grant.action === action,
    ),
  );
  const {
    data: allSkills,
    isError: skillsLoadError,
    refetch: refetchSkills,
  } = useAllSkills({
    enabled: skillsEnabled && canAdminSkills === true,
    // The catalogue is expensive, but the profile includes a snapshot of every
    // selected skill, so wait until the rest of the page settles before loading.
    deferMs: 750,
    throwOnError: true,
  });
  const skills = allSkills ?? EMPTY_SKILLS;
  const skillsEligible =
    skillsEnabled &&
    canAdminSkills === true &&
    allSkills !== undefined &&
    skills.length > 0;
  const skillIds = useMemo(() => skills.map((s) => s.id), [skills]);
  const skillIdsKey = JSON.stringify(skillIds);
  const [includeSkills, setIncludeSkills] = useState(true);
  const { mutateAsync: createSkillShareLink } = useCreateSkillShareLink();
  const [skillMarketplace, setSkillMarketplace] =
    useState<SkillMarketplacePreparation>({ status: "not-applicable" });
  const skillPreparationRef = useRef<{
    key: string;
    request: number;
    status: "loading" | "ready";
  } | null>(null);
  const skillPreparationRequestRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const prepareSkillMarketplace = useCallback(
    (force = false) => {
      if (!canPrepareProfile || !includeSkills || !skillsEligible) return;
      const existing = skillPreparationRef.current;
      if (
        !force &&
        existing?.key === skillIdsKey &&
        (existing.status === "loading" || existing.status === "ready")
      ) {
        return;
      }

      const request = ++skillPreparationRequestRef.current;
      skillPreparationRef.current = {
        key: skillIdsKey,
        request,
        status: "loading",
      };
      setSkillMarketplace({ status: "loading" });
      void createSkillShareLink({ skillIds, expiresAt: null })
        .then((link) => {
          if (
            !isMountedRef.current ||
            skillPreparationRequestRef.current !== request
          ) {
            return;
          }
          if (!link) {
            skillPreparationRef.current = null;
            setSkillMarketplace({ status: "error" });
            return;
          }
          skillPreparationRef.current = {
            key: skillIdsKey,
            request,
            status: "ready",
          };
          setSkillMarketplace({
            status: "ready",
            cloneUrl: link.cloneUrl,
            marketplaceName: link.marketplaceName,
          });
        })
        .catch(() => {
          if (
            !isMountedRef.current ||
            skillPreparationRequestRef.current !== request
          ) {
            return;
          }
          skillPreparationRef.current = null;
          setSkillMarketplace({ status: "error" });
        });
    },
    [
      createSkillShareLink,
      canPrepareProfile,
      includeSkills,
      skillIds,
      skillIdsKey,
      skillsEligible,
    ],
  );

  useEffect(() => {
    if (!canPrepareProfile) {
      skillPreparationRequestRef.current += 1;
      skillPreparationRef.current = null;
      setSkillMarketplace({ status: "not-applicable" });
      return;
    }
    if (
      canAdminSkills === undefined ||
      (canAdminSkills && allSkills === undefined && !skillsLoadError)
    ) {
      skillPreparationRequestRef.current += 1;
      skillPreparationRef.current = null;
      setSkillMarketplace({ status: "loading" });
      return;
    }
    if (skillsLoadError) {
      skillPreparationRequestRef.current += 1;
      skillPreparationRef.current = null;
      setSkillMarketplace({ status: "error" });
      return;
    }
    if (!includeSkills || !skillsEligible) {
      skillPreparationRequestRef.current += 1;
      skillPreparationRef.current = null;
      setSkillMarketplace({ status: "not-applicable" });
      return;
    }
    prepareSkillMarketplace();
  }, [
    allSkills,
    canAdminSkills,
    canPrepareProfile,
    includeSkills,
    prepareSkillMarketplace,
    skillsEligible,
    skillsLoadError,
  ]);

  const retrySkillMarketplace = useCallback(() => {
    if (skillsLoadError) {
      setSkillMarketplace({ status: "loading" });
      void refetchSkills().then(({ error }) => {
        if (error) setSkillMarketplace({ status: "error" });
      });
      return;
    }
    if (canPrepareProfile) prepareSkillMarketplace(true);
  }, [
    canPrepareProfile,
    prepareSkillMarketplace,
    refetchSkills,
    skillsLoadError,
  ]);

  // The import step only makes sense once a profile can actually be produced. When
  // the download is blocked for good (no virtual-key permission, or no Anthropic
  // key to back the embedded key), they're just noise, so we hide them and let
  // step 3 carry the explanation.
  const skillMarketplaceUrlSupported =
    skillMarketplace.status !== "ready" ||
    isClaudeDesktopProfileUrlSupported(skillMarketplace.cloneUrl);
  const profileUrlError = !profileBaseUrlSupported
    ? "Claude Desktop configuration profiles require an HTTPS endpoint (or HTTP on localhost). Select an HTTPS endpoint in the review step, or ask an administrator to configure one for this deployment."
    : !skillMarketplaceUrlSupported
      ? "The shared skills marketplace needs an HTTPS URL (or HTTP on localhost) before Claude Desktop can import the profile. Turn off shared skills, or ask an administrator to configure HTTPS."
      : null;
  const downloadBlocked =
    (llmProxyEnabled && profileAvailability.unavailable) || !!profileUrlError;
  // When shared skills ride along, give Claude Desktop users the separate
  // marketplace setup and plugin-install path.
  const showSkillsInstallStep =
    !downloadBlocked && skillMarketplace.status === "ready";

  const gateway = mcpGateways?.find((g) => g.id === mcpGatewayId) ?? null;

  const showEndpoint = candidateBaseUrls.length > 1;
  const canPickGateway =
    !!gateway && mcpGateways !== null && mcpGateways.length > 1;

  // The profile's usual point is the inference endpoint. When the org has
  // turned that off, MCP-only profiles are still useful. When the caller
  // simply cannot read the proxy, keep the previous fail-closed copy.
  if (llmProxyEnabled && !llmProxyId) {
    return (
      <WizardStep n={2} title="Review the setup" last>
        <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          Access to the{" "}
          <Link href="/llm/proxy" className="underline hover:text-foreground">
            LLM Proxy
          </Link>{" "}
          is required to generate a configuration profile.
        </div>
      </WizardStep>
    );
  }

  if (!llmProxyEnabled && !gateway) {
    return (
      <WizardStep n={2} title="Review the setup" last>
        <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          {(mcpGateways?.length ?? 0) === 0 ? (
            <>
              An{" "}
              <Link
                href="/mcp/gateways"
                className="underline hover:text-foreground"
              >
                MCP gateway
              </Link>{" "}
              is required to generate a configuration profile.
            </>
          ) : (
            <span>
              Select an MCP gateway to generate a configuration profile.
            </span>
          )}
        </div>
      </WizardStep>
    );
  }

  return (
    <>
      <WizardStep n={2} title="Review the setup">
        <ul className="grid gap-2">
          {gateway && (
            <SummaryRow
              editable={canPickGateway}
              isEditing={editing === "gateway"}
              onToggle={() => toggleEdit("gateway")}
              editor={
                <EditorField label="Gateway">
                  <AgentSelector
                    mode="single"
                    flat
                    className="w-full"
                    agents={mcpGateways ?? []}
                    value={gateway.id}
                    onValueChange={onMcpGatewaySelect}
                    placeholder="Select gateway"
                    searchPlaceholder="Search gateways…"
                  />
                </EditorField>
              }
              detail={<GatewayServersSummary gatewayId={gateway.id} />}
            >
              Connect{" "}
              <ResourceLink href="/mcp/gateways">{gateway.name}</ResourceLink>{" "}
              for tools
            </SummaryRow>
          )}
          {llmProxyEnabled && (
            <SummaryRow>
              Route{" "}
              <span className="font-medium text-foreground">
                {providerCatalog.label("anthropic")}
              </span>{" "}
              through{" "}
              <ResourceLink href="/llm/proxy">the LLM Proxy</ResourceLink>
            </SummaryRow>
          )}
          {skillsEligible && (
            <SummaryRow
              done={includeSkills}
              editable
              isEditing={editing === "skills"}
              onToggle={() => toggleEdit("skills")}
              editor={
                <label
                  className="flex items-center gap-2 text-sm font-medium"
                  htmlFor="config-include-skills"
                >
                  <Checkbox
                    id="config-include-skills"
                    checked={includeSkills}
                    onCheckedChange={(c) => setIncludeSkills(c === true)}
                  />
                  Install shared skills
                </label>
              }
              detail={
                includeSkills ? <SkillNamesLine skills={skills} /> : undefined
              }
            >
              {includeSkills ? (
                <span key="skills">
                  Install{" "}
                  <ResourceLink href="/skills">
                    {skills.length} shared skill
                    {skills.length === 1 ? null : <span>s</span>}
                  </ResourceLink>{" "}
                  as a marketplace
                </span>
              ) : (
                <span key="none">Shared skills not installed</span>
              )}
            </SummaryRow>
          )}
          {showEndpoint && (
            <SummaryRow
              editable
              isEditing={editing === "endpoint"}
              onToggle={() => toggleEdit("endpoint")}
              editor={
                <EditorField label="Endpoint">
                  <BaseUrlSelect
                    candidateUrls={candidateBaseUrls}
                    metadata={baseUrlMetadata}
                    value={baseUrl}
                    onChange={onBaseUrlChange}
                  />
                </EditorField>
              }
            >
              Reach the gateway and proxy at{" "}
              <span className="font-medium text-foreground">{baseUrl}</span>
            </SummaryRow>
          )}
          <SummaryRow
            editable
            isEditing={editing === "platform"}
            onToggle={() => toggleEdit("platform")}
            editor={
              <EditorField label="Platform">
                <ConnectionPlatformToggle
                  value={platform}
                  onValueChange={setPlatform}
                />
              </EditorField>
            }
          >
            Run on{" "}
            <span className="inline-flex items-center gap-1.5 align-middle font-medium text-foreground">
              <OsLogos platform={platform} />
              {platformLabels[platform]}
            </span>
          </SummaryRow>
        </ul>
      </WizardStep>

      <WizardStep
        n={3}
        title="Download your configuration profile"
        last={downloadBlocked}
      >
        <div className="flex flex-col gap-3">
          {llmProxyEnabled && (
            <Alert variant="info">
              <Info />
              <AlertDescription>
                Claude Desktop's third-party inference cannot reuse a Claude Pro
                or Max subscription. To keep paying through a subscription,
                connect Claude Code in passthrough mode instead.
              </AlertDescription>
            </Alert>
          )}
          <ConfigDownloadStep
            baseUrl={baseUrl}
            llmProxyId={llmProxyEnabled ? llmProxyId : null}
            gateway={
              gateway
                ? { slug: gatewaySlug ?? gateway.id, name: gateway.name }
                : null
            }
            skillMarketplace={skillMarketplace}
            onRetrySkills={retrySkillMarketplace}
            profileUrlError={profileUrlError}
          />
        </div>
      </WizardStep>

      {!downloadBlocked && (
        <WizardStep
          n={4}
          title="Import the profile into Claude Desktop"
          last={!showSkillsInstallStep && !gateway}
        >
          <div className="space-y-4 text-sm text-muted-foreground">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                From the Claude menu choose{" "}
                <strong className="font-medium text-foreground">
                  Help → Troubleshooting → Enable Developer Mode
                </strong>
                .
              </li>
              <li>
                From the Claude menu choose{" "}
                <strong className="font-medium text-foreground">
                  Developer → Configure Third-Party Inference…
                </strong>
                .
              </li>
              <li>
                Click the{" "}
                <strong className="font-medium text-foreground">Default</strong>{" "}
                dropdown in the top-right corner and choose{" "}
                <strong className="font-medium text-foreground">
                  Import configuration…
                </strong>
                .
              </li>
              <li>Select the configuration file you downloaded above.</li>
              <li>
                Click{" "}
                <strong className="font-medium text-foreground">
                  Apply Changes
                </strong>{" "}
                and restart Claude Desktop.
              </li>
            </ol>
          </div>
        </WizardStep>
      )}

      {showSkillsInstallStep && (
        <WizardStep n={5} title="Install shared skills" last={!gateway}>
          <div className="space-y-4 text-sm text-muted-foreground">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Go to{" "}
                <strong className="font-medium text-foreground">
                  Settings → Plugins → Browse plugins
                </strong>
                .
              </li>
              <li>
                Install the{" "}
                <strong className="font-medium text-foreground">
                  {skillMarketplace.marketplaceName}
                </strong>{" "}
                marketplace.
              </li>
            </ol>
          </div>
        </WizardStep>
      )}

      {!downloadBlocked && gateway && (
        <WizardStep
          n={showSkillsInstallStep ? 6 : 5}
          title={FINISH_OAUTH_FLOW_TITLE}
          last
        >
          <p className="mb-3 text-sm text-muted-foreground">
            The profile only registers the connector — the gateway grants tool
            access per user, so its tools appear in chat only after you sign in
            once and approve it for your account.
          </p>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              Go to{" "}
              <strong className="font-medium text-foreground">
                Settings → Connectors
              </strong>
              .
            </li>
            <li>
              Select your new{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                archestra-mcp-*
              </code>{" "}
              connector and click{" "}
              <strong className="font-medium text-foreground">Connect</strong>.
            </li>
            <li>
              Claude Desktop opens your browser. Sign in and approve the
              gateway.
            </li>
          </ol>
        </WizardStep>
      )}
    </>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

/** Amber advisory box — inference-billing warning and the sensitive-file note. */
function AmberNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[12.5px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

type EditableRow = "gateway" | "proxy" | "skills" | "endpoint" | "platform";

type ProvisionState =
  | { status: "loading" }
  | {
      status: "ready";
      passthroughKey: string | null;
      virtualKey: string | null;
      creditWarning?: ConnectionCreditWarning | null;
    }
  | { status: "error" };

type SkillMarketplacePreparation =
  | { status: "not-applicable" | "loading" | "error" }
  | { status: "ready"; cloneUrl: string; marketplaceName: string };

/**
 * The two prerequisites for producing a configuration profile: permission to
 * mint virtual keys, and an {Anthropic} provider key for the embedded key to be
 * minted from. Read both by the download step (which explains a missing one)
 * and by the panel (which hides the import/OAuth steps once the download is
 * known impossible).
 *
 * `unavailable` flips true only once a prerequisite is *known* missing — never
 * while the checks are still loading — so the happy path never flashes the
 * later steps out and back in. A transient provisioning error is deliberately
 * not "unavailable": it's retryable, so the follow-up steps stay put.
 */
function useConfigProfileAvailability(): {
  canCreateVirtualKey: boolean | undefined;
  canCreateProviderKey: boolean | undefined;
  anthropicHasKey: boolean;
  unavailable: boolean;
} {
  const { data: canCreateVirtualKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const { data: canCreateProviderKey } = useHasPermissions({
    llmProviderApiKey: ["create"],
  });
  const { data: availableKeys } = useAvailableLlmProviderApiKeys();
  const anthropicHasKey = (availableKeys ?? []).some(
    (k) => k.provider === "anthropic",
  );
  const unavailable =
    canCreateVirtualKey === false ||
    (canCreateVirtualKey === true &&
      availableKeys !== undefined &&
      !anthropicHasKey);
  return {
    canCreateVirtualKey,
    canCreateProviderKey,
    anthropicHasKey,
    unavailable,
  };
}

/**
 * The artifact step. Provisions the caller's passthrough + standard virtual
 * keys (the standard key needs a configured Anthropic provider key — mirrors
 * the command panel's handling), then downloads the prepared profile. The
 * marketplace link is prepared by the parent so preview, instructions, and
 * every repeated download use one real, consistent marketplace.
 */
function ConfigDownloadStep({
  baseUrl,
  llmProxyId,
  gateway,
  skillMarketplace,
  onRetrySkills,
  profileUrlError,
}: {
  baseUrl: string;
  /** Needed for the passthrough-key provisioning payload, not URLs. */
  llmProxyId: string | null;
  gateway: { slug: string; name: string } | null;
  skillMarketplace: SkillMarketplacePreparation;
  onRetrySkills: () => void;
  profileUrlError: string | null;
}) {
  const providerCatalog = useModelProviderCatalog();
  const { canCreateVirtualKey, canCreateProviderKey, anthropicHasKey } =
    useConfigProfileAvailability();

  const { mutateAsync: provisionPassthrough } =
    useCreateConnectionPassthroughKey();
  const { mutateAsync: provisionVirtual } = useCreateConnectionVirtualKey();

  const [state, setState] = useState<ProvisionState>(
    llmProxyId
      ? { status: "loading" }
      : { status: "ready", passthroughKey: null, virtualKey: null },
  );
  const [showAddProviderKey, setShowAddProviderKey] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Both calls are idempotent server-side (they reuse an existing key), so a
  // single fire is enough; the ref survives strict-mode's double-invoke.
  const firedRef = useRef(false);
  const provision = useCallback(() => {
    if (!llmProxyId) {
      setState({ status: "ready", passthroughKey: null, virtualKey: null });
      return;
    }
    setState({ status: "loading" });
    Promise.all([
      provisionPassthrough({ llmProxyId }),
      provisionVirtual({ provider: "anthropic" }),
    ])
      .then(([passthrough, virtual]) => {
        setState(
          passthrough && virtual
            ? {
                status: "ready",
                passthroughKey: passthrough.value,
                virtualKey: virtual.value,
                creditWarning: virtual.creditWarning,
              }
            : { status: "error" },
        );
      })
      .catch(() => setState({ status: "error" }));
  }, [provisionPassthrough, provisionVirtual, llmProxyId]);

  // Provision once the prerequisites resolve: the user can mint keys and the
  // Anthropic provider key (which the standard virtual key wraps) exists.
  useEffect(() => {
    if (profileUrlError) return;
    if (!llmProxyId) return;
    if (canCreateVirtualKey !== true || !anthropicHasKey) return;
    if (firedRef.current) return;
    firedRef.current = true;
    provision();
  }, [
    llmProxyId,
    canCreateVirtualKey,
    anthropicHasKey,
    profileUrlError,
    provision,
  ]);

  if (profileUrlError) {
    return <p className="text-sm text-muted-foreground">{profileUrlError}</p>;
  }

  if (llmProxyId && canCreateVirtualKey === false) {
    return (
      <p className="text-sm text-muted-foreground">
        You don't have permission to create virtual keys. Ask an admin to
        generate a configuration profile, or open the Connect dialog on the{" "}
        <Link
          href="/llm/proxy"
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          LLM Proxy
        </Link>{" "}
        page.
      </p>
    );
  }

  // No Anthropic provider key → the standard virtual key can't be minted. Offer
  // to add one inline (or point at an admin), exactly like the command panel.
  if (llmProxyId && canCreateVirtualKey === true && !anthropicHasKey) {
    return (
      <>
        <p className="text-sm text-muted-foreground">
          You need an {providerCatalog.label("anthropic")} provider key before
          you can download a profile — the profile uses it to authorize
          inference, and none is configured yet.{" "}
          {canCreateProviderKey ? (
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              onClick={() => setShowAddProviderKey(true)}
            >
              Add an {providerCatalog.label("anthropic")} key
            </button>
          ) : (
            <>
              Ask an admin to add an {providerCatalog.label("anthropic")} key.
            </>
          )}
        </p>
        <CreateLlmProviderApiKeyDialog
          open={showAddProviderKey}
          onOpenChange={setShowAddProviderKey}
          title={`Add an ${providerCatalog.label("anthropic")} key`}
          description={`Add an ${providerCatalog.label("anthropic")} provider API key so a virtual key can be minted from it for the configuration profile.`}
          defaultValues={{ provider: "anthropic" }}
          allowedProviders={["anthropic"]}
          onSuccess={() => setShowAddProviderKey(false)}
        />
      </>
    );
  }

  if (state.status === "error") {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't provision your keys.{" "}
        <button
          type="button"
          onClick={provision}
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          Retry
        </button>
        .
      </p>
    );
  }

  if (state.status !== "ready") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>Provisioning your keys…</span>
      </div>
    );
  }

  if (skillMarketplace.status === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>Preparing your shared skills marketplace…</span>
      </div>
    );
  }

  if (skillMarketplace.status === "error") {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't prepare your shared skills marketplace.{" "}
        <button
          type="button"
          onClick={onRetrySkills}
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          Retry
        </button>
        .
      </p>
    );
  }

  // Preview and download share this object, so the reviewed profile is exactly
  // what the user receives. A new opaque filename is still generated per click.
  const profile = buildClaudeDesktopConfigProfile({
    baseUrl,
    passthroughKey: state.passthroughKey,
    virtualKey: state.virtualKey,
    gateway,
    skillMarketplace:
      skillMarketplace.status === "ready" ? skillMarketplace : null,
  });

  return (
    <div className="flex flex-col gap-3">
      <CreditWarningNotice warning={state.creditWarning} />
      <AmberNotice>
        The configuration file contains sensitive values in plain text. Do not
        share it.
      </AmberNotice>
      <div>
        {/* The button only renders here — after the authenticated user's own
            passthrough + virtual keys were minted via permission-checked
            endpoints — so an unauthenticated/unauthorized visitor never sees it
            or the keys it embeds. A fresh file-name token is minted per click. */}
        <Button
          type="button"
          onClick={() =>
            downloadClaudeDesktopConfig(profile, generateConfigFilename())
          }
          data-testid="connect-download-config"
        >
          <Download className="size-4" />
          <span>Download configuration</span>
        </Button>
      </div>
      <button
        type="button"
        onClick={() => setShowPreview((s) => !s)}
        className="self-start text-xs text-muted-foreground/70 hover:text-foreground hover:underline"
      >
        {showPreview ? "Hide" : "Preview"} configuration
      </button>
      {showPreview && (
        <div className="min-w-0 space-y-2">
          <pre className="m-0 overflow-x-auto rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed text-foreground">
            {JSON.stringify(maskConfigSecrets(profile), null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * One review line: a status check, the summary text, and (when there's a real
 * choice) an inline "Change" that expands the row's own editor below it.
 */
function SummaryRow({
  children,
  done = true,
  editable = false,
  isEditing = false,
  onToggle,
  editor,
  detail,
}: {
  children: React.ReactNode;
  /** Green check vs. a muted "not included" indicator. */
  done?: boolean;
  editable?: boolean;
  isEditing?: boolean;
  onToggle?: () => void;
  editor?: React.ReactNode;
  /** Extra context under the line (e.g. what the gateway contains). */
  detail?: React.ReactNode;
}) {
  return (
    <li className="text-sm text-muted-foreground">
      <div className="flex items-start gap-2">
        {done ? (
          <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        ) : (
          <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
        )}
        <span>
          {children}
          {editable && (
            <>
              {" "}
              <button
                type="button"
                onClick={onToggle}
                className="text-xs text-muted-foreground/70 hover:text-foreground hover:underline"
              >
                {isEditing ? "Done" : "Change"}
              </button>
            </>
          )}
        </span>
      </div>
      {detail && <div className="ml-6 mt-1.5">{detail}</div>}
      {isEditing && editor && (
        <div className="ml-6 mt-2 max-w-md rounded-lg border bg-muted/20 p-3">
          {editor}
        </div>
      )}
    </li>
  );
}

function ResourceLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
    >
      {children}
    </Link>
  );
}

const SKILL_NAME_PREVIEW_LIMIT = 6;

/** Names the skills the marketplace will expose, truncated past the limit. */
function SkillNamesLine({ skills }: { skills: ConnectSkill[] }) {
  const shown = skills.slice(0, SKILL_NAME_PREVIEW_LIMIT);
  const more = skills.length - shown.length;
  return (
    <p className="text-xs text-muted-foreground/80">
      {shown.map((s) => s.name).join(", ")}
      {more > 0 ? <span> and {more} more</span> : null}
    </p>
  );
}

function EditorField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function BaseUrlSelect({
  candidateUrls,
  metadata,
  value,
  onChange,
}: {
  candidateUrls: readonly string[];
  metadata: readonly ConnectionBaseUrl[] | null | undefined;
  value: string;
  onChange: (url: string) => void;
}) {
  const metaByUrl = new Map((metadata ?? []).map((m) => [m.url, m] as const));
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-[var(--radix-select-trigger-width)]">
        {candidateUrls.map((url) => {
          const description = metaByUrl.get(url)?.description ?? "";
          return (
            <SelectItem key={url} value={url}>
              <span className="flex min-w-0 items-center gap-2">
                <code className="shrink-0 font-mono text-xs">{url}</code>
                {description && (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {description}
                  </span>
                )}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
