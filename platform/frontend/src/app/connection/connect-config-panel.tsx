"use client";

import { providerDisplayNames } from "@archestra/shared";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useCreateConnectionPassthroughKey,
  useCreateConnectionVirtualKey,
} from "@/lib/connection-setup.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useCreateSkillShareLink } from "@/lib/skills/skill-share.query";
import {
  buildClaudeDesktopConfigProfile,
  downloadClaudeDesktopConfig,
  generateConfigFilename,
  maskConfigSecrets,
} from "./claude-desktop-config";
import { FINISH_OAUTH_FLOW_TITLE } from "./clients";
import type { ConnectionBaseUrl } from "./connection-flow.utils";
import { GatewayServersSummary } from "./gateway-servers-summary";
import { OsLogos } from "./os-logos";
import {
  CONNECT_PLATFORM_OPTIONS,
  type ConnectPlatformOption,
  detectPlatform,
  platformLabels,
  toPlatformOption,
} from "./platform.utils";
import { type ConnectSkill, useAllSkills } from "./skills-marketplace-step";
import { WizardStep } from "./wizard-step";

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
  /** null when the user can't read LLM proxies. */
  llmProxies: AgentSelectorAgent[] | null;
  llmProxyId: string | null;
  onLlmProxySelect: (id: string) => void;
  baseUrl: string;
  candidateBaseUrls: readonly string[];
  baseUrlMetadata: readonly ConnectionBaseUrl[] | null | undefined;
  onBaseUrlChange: (url: string) => void;
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
  llmProxies,
  llmProxyId,
  onLlmProxySelect,
  baseUrl,
  candidateBaseUrls,
  baseUrlMetadata,
  onBaseUrlChange,
}: ConnectConfigPanelProps) {
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
  // Whole-org snapshot (no per-skill picker) — Claude Desktop surfaces the
  // marketplace in its Directory, where the user installs individual skills.
  const { data: canAdminSkills } = useHasPermissions({ skill: ["admin"] });
  const { data: allSkills } = useAllSkills({
    enabled: canAdminSkills === true,
  });
  const skills = allSkills ?? [];
  const skillsEligible = canAdminSkills === true && skills.length > 0;
  const skillIds = useMemo(() => skills.map((s) => s.id), [skills]);
  const [includeSkills, setIncludeSkills] = useState(true);

  const gateway = mcpGateways?.find((g) => g.id === mcpGatewayId) ?? null;
  const proxy = (llmProxies ?? []).find((p) => p.id === llmProxyId) ?? null;

  const showEndpoint = candidateBaseUrls.length > 1;
  const canPickGateway =
    !!gateway && mcpGateways !== null && mcpGateways.length > 1;
  const canPickProxy = !!proxy && (llmProxies?.length ?? 0) > 1;

  // The profile's whole point is the inference endpoint, so a proxy is
  // required; the MCP gateway is optional (it only adds the managed server).
  if (!proxy) {
    return (
      <WizardStep n={2} title="Review the setup" last>
        <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          Select an{" "}
          <Link href="/llm/proxies" className="underline hover:text-foreground">
            LLM proxy
          </Link>{" "}
          to generate a configuration profile.
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
          <SummaryRow
            editable={canPickProxy}
            isEditing={editing === "proxy"}
            onToggle={() => toggleEdit("proxy")}
            editor={
              <EditorField label="Proxy">
                <AgentSelector
                  mode="single"
                  flat
                  className="w-full"
                  agents={llmProxies ?? []}
                  value={proxy.id}
                  onValueChange={onLlmProxySelect}
                  placeholder="Select proxy"
                  searchPlaceholder="Search proxies…"
                />
              </EditorField>
            }
          >
            Route{" "}
            <span className="font-medium text-foreground">
              {providerDisplayNames.anthropic}
            </span>{" "}
            through{" "}
            <ResourceLink href="/llm/proxies">{proxy.name}</ResourceLink>
          </SummaryRow>
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
                <>
                  Install{" "}
                  <ResourceLink href="/skills">
                    {skills.length} shared skill{skills.length === 1 ? "" : "s"}
                  </ResourceLink>{" "}
                  as a marketplace
                </>
              ) : (
                "Shared skills not installed"
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
                <Select
                  value={platform}
                  onValueChange={(v) => setPlatform(v as ConnectPlatformOption)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONNECT_PLATFORM_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p}>
                        <span className="flex items-center gap-2">
                          <OsLogos platform={p} />
                          {platformLabels[p]}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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

      <WizardStep n={3} title="Download your configuration profile">
        <div className="flex flex-col gap-3">
          <Alert variant="info">
            <Info />
            <AlertDescription>
              Claude Desktop's third-party inference cannot reuse a Claude Pro
              or Max subscription. To keep paying through a subscription,
              connect Claude Code in passthrough mode instead.
            </AlertDescription>
          </Alert>
          <ConfigDownloadStep
            baseUrl={baseUrl}
            llmProxyId={proxy.id}
            gateway={
              gateway
                ? { slug: gatewaySlug ?? gateway.id, name: gateway.name }
                : null
            }
            includeSkills={skillsEligible && includeSkills}
            skillIds={skillIds}
          />
        </div>
      </WizardStep>

      <WizardStep
        n={4}
        title="Import the profile into Claude Desktop"
        last={!gateway}
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

      {gateway && (
        <WizardStep n={5} title={FINISH_OAUTH_FLOW_TITLE} last>
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
      passthroughKey: string;
      virtualKey: string;
      creditWarning?: ConnectionCreditWarning | null;
    }
  | { status: "error" };

/**
 * The artifact step. Provisions the caller's passthrough + standard virtual
 * keys (the standard key needs a configured Anthropic provider key — mirrors
 * the command panel's handling), builds the profile, and offers the download.
 *
 * When skills are included, the token-bearing marketplace clone URL is minted
 * on the download click (not eagerly), so a visitor who only previews never
 * spawns a share link, and the "Share link created" toast stays tied to a
 * deliberate action.
 */
function ConfigDownloadStep({
  baseUrl,
  llmProxyId,
  gateway,
  includeSkills,
  skillIds,
}: {
  baseUrl: string;
  llmProxyId: string;
  gateway: { slug: string; name: string } | null;
  /** Already gated on skill-admin eligibility by the parent. */
  includeSkills: boolean;
  skillIds: string[];
}) {
  const { data: canCreateVirtualKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const { data: canCreateProviderKey } = useHasPermissions({
    llmProviderApiKey: ["create"],
  });
  const { data: availableKeys } = useAvailableLlmProviderApiKeys();
  const anthropicHasKey = useMemo(
    () => (availableKeys ?? []).some((k) => k.provider === "anthropic"),
    [availableKeys],
  );

  const { mutateAsync: provisionPassthrough } =
    useCreateConnectionPassthroughKey();
  const { mutateAsync: provisionVirtual } = useCreateConnectionVirtualKey();
  const { mutateAsync: createShareLink, isPending: mintingShareLink } =
    useCreateSkillShareLink();

  const [state, setState] = useState<ProvisionState>({ status: "loading" });
  const [showAddProviderKey, setShowAddProviderKey] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  // Set when the share-link mint fails on a download click, so the profile is
  // never silently downloaded without the skills the user asked for.
  const [skillMintFailed, setSkillMintFailed] = useState(false);

  // Both calls are idempotent server-side (they reuse an existing key), so a
  // single fire is enough; the ref survives strict-mode's double-invoke.
  const firedRef = useRef(false);
  const provision = useCallback(() => {
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
    if (canCreateVirtualKey !== true || !anthropicHasKey) return;
    if (firedRef.current) return;
    firedRef.current = true;
    provision();
  }, [canCreateVirtualKey, anthropicHasKey, provision]);

  // Build + download on click. When skills are included, the marketplace share
  // link is minted here (not eagerly) so previewing never spawns a link, and
  // its failure aborts the download rather than shipping a skill-less profile.
  const handleDownload = useCallback(async () => {
    if (state.status !== "ready") return;
    setSkillMintFailed(false);
    let skillMarketplace: {
      cloneUrl: string;
      marketplaceName: string;
    } | null = null;
    if (includeSkills && skillIds.length > 0) {
      // Never expires — the marketplace must outlive any single download;
      // admins revoke it from the Skills page. The hook toasts on failure.
      const link = await createShareLink({ skillIds, expiresAt: null });
      if (!link) {
        setSkillMintFailed(true);
        return;
      }
      skillMarketplace = {
        cloneUrl: link.cloneUrl,
        marketplaceName: link.marketplaceName,
      };
    }
    const profile = buildClaudeDesktopConfigProfile({
      baseUrl,
      llmProxyId,
      passthroughKey: state.passthroughKey,
      virtualKey: state.virtualKey,
      gateway,
      skillMarketplace,
    });
    downloadClaudeDesktopConfig(profile, generateConfigFilename());
  }, [
    state,
    includeSkills,
    skillIds,
    createShareLink,
    baseUrl,
    llmProxyId,
    gateway,
  ]);

  if (canCreateVirtualKey === false) {
    return (
      <p className="text-sm text-muted-foreground">
        You don't have permission to create virtual keys. Ask an admin to
        generate a configuration profile, or create the keys on the{" "}
        <Link
          href="/llm/credentials/virtual-keys"
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          Virtual API Keys
        </Link>{" "}
        page.
      </p>
    );
  }

  // No Anthropic provider key → the standard virtual key can't be minted. Offer
  // to add one inline (or point at an admin), exactly like the command panel.
  if (canCreateVirtualKey === true && !anthropicHasKey) {
    return (
      <>
        <p className="text-sm text-muted-foreground">
          A configuration profile embeds a virtual key minted from your{" "}
          {providerDisplayNames.anthropic} provider key, but none is configured
          yet.{" "}
          {canCreateProviderKey ? (
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              onClick={() => setShowAddProviderKey(true)}
            >
              Add an {providerDisplayNames.anthropic} key
            </button>
          ) : (
            <>Ask an admin to add an {providerDisplayNames.anthropic} key.</>
          )}
        </p>
        <CreateLlmProviderApiKeyDialog
          open={showAddProviderKey}
          onOpenChange={setShowAddProviderKey}
          title={`Add an ${providerDisplayNames.anthropic} key`}
          description={`Add an ${providerDisplayNames.anthropic} provider API key so a virtual key can be minted from it for the configuration profile.`}
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
        Provisioning your keys…
      </div>
    );
  }

  // Preview reflects the non-skill profile only: the marketplace clone URL is
  // minted on download, so there's no real value to show until then. The note
  // below the button covers the skills part.
  const previewProfile = buildClaudeDesktopConfigProfile({
    baseUrl,
    llmProxyId,
    passthroughKey: state.passthroughKey,
    virtualKey: state.virtualKey,
    gateway,
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
          onClick={handleDownload}
          disabled={mintingShareLink}
          data-testid="connect-download-config"
        >
          {mintingShareLink ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          {mintingShareLink ? "Preparing…" : "Download configuration"}
        </Button>
      </div>
      {includeSkills && (
        <p className="text-xs text-muted-foreground">
          The profile also registers your shared skills as a marketplace, using
          a token-bearing git URL generated when you download.
        </p>
      )}
      {skillMintFailed && (
        <p className="text-xs text-destructive">
          Couldn't prepare the skills marketplace.{" "}
          <button
            type="button"
            onClick={handleDownload}
            className="font-medium underline underline-offset-2"
          >
            Retry
          </button>
          , or clear "Install shared skills" to download without it.
        </p>
      )}
      <button
        type="button"
        onClick={() => setShowPreview((s) => !s)}
        className="self-start text-xs text-muted-foreground/70 hover:text-foreground hover:underline"
      >
        {showPreview ? "Hide" : "Preview"} configuration
      </button>
      {showPreview && (
        <pre className="m-0 overflow-x-auto rounded-lg border bg-muted/30 p-3 font-mono text-[12px] leading-relaxed text-foreground">
          {JSON.stringify(maskConfigSecrets(previewProfile), null, 2)}
        </pre>
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
      {more > 0 ? ` and ${more} more` : ""}
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
    <div className="grid items-center gap-2 sm:grid-cols-[88px_1fr]">
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
