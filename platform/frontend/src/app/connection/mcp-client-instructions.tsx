"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyableCode } from "@/components/copyable-code";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useFetchTeamTokenValue,
  useTokens,
} from "@/lib/teams/team-token.query";
import { useFetchUserTokenValue, useUserToken } from "@/lib/user-token.query";
import { cn } from "@/lib/utils";
import { ClientIcon } from "./client-icon";
import type {
  ConnectClient,
  McpBuildParams,
  McpSupportedAuth,
} from "./clients";
import { toMcpServerSlug } from "./connection-flow.utils";
import { TerminalBlock } from "./terminal-block";

interface McpClientInstructionsProps {
  client: ConnectClient;
  gatewayId: string;
  gatewaySlug: string;
  gatewayName: string;
  /** Connection base URL chosen at the page level (see ConnectionUrlStep). */
  baseUrl: string;
}

type AuthMethod = "oauth" | "token";

function authTabs(supported: McpSupportedAuth): AuthMethod[] {
  if (supported === "oauth") return ["oauth"];
  if (supported === "token") return ["token"];
  return ["oauth", "token"];
}

export function McpClientInstructions({
  client,
  gatewayId,
  gatewaySlug,
  gatewayName,
  baseUrl,
}: McpClientInstructionsProps) {
  const supportedAuth =
    client.mcp.kind === "unsupported" ? "both" : client.mcp.supportedAuth;
  const preferredAuth =
    client.mcp.kind === "custom"
      ? (client.mcp.preferredAuth ?? "oauth")
      : "oauth";
  const tabs = authTabs(supportedAuth);
  if (preferredAuth === "token" && tabs.length > 1) tabs.reverse();
  const [authMethod, setAuthMethod] = useState<AuthMethod>(tabs[0]);
  const appName = useAppName();

  // If the selected tab isn't supported by a newly-switched client, snap back.
  useEffect(() => {
    if (!tabs.includes(authMethod)) setAuthMethod(tabs[0]);
  }, [authMethod, tabs]);

  if (client.mcp.kind === "unsupported") {
    return <UnsupportedPanel reason={client.mcp.reason} />;
  }

  const mcpUrl = `${baseUrl}/mcp/${gatewaySlug}`;
  const serverName = gatewayName.trim()
    ? gatewayName.trim().toLowerCase().replace(/\s+/g, "_")
    : toMcpServerSlug(appName);
  const isQuick = client.mcp.kind === "custom" && client.mcp.quick === true;

  return (
    <div id="mcp-instructions" className="space-y-4">
      {client.mcp.kind === "generic" && <Eyebrow>Authentication</Eyebrow>}
      {tabs.length > 1 ? (
        <Tabs
          value={authMethod}
          onValueChange={(v) => setAuthMethod(v as AuthMethod)}
          className="-mt-2"
        >
          <TabsList className="w-full">
            {tabs.map((t) =>
              t === "oauth" ? (
                <TabsTrigger key="oauth" value="oauth" className="flex-1">
                  OAuth 2.1
                  {client.mcp.kind !== "generic" &&
                    preferredAuth === "oauth" && (
                      <span className="ml-1.5 text-[10px] opacity-70">
                        Recommended
                      </span>
                    )}
                </TabsTrigger>
              ) : (
                <TabsTrigger key="token" value="token" className="flex-1">
                  Static token
                </TabsTrigger>
              ),
            )}
          </TabsList>

          <TabsContent value="oauth" className="mt-4">
            <McpBody
              client={client}
              mcpUrl={mcpUrl}
              token={null}
              serverName={serverName}
              gatewayId={gatewayId}
              isQuick={isQuick}
            />
          </TabsContent>

          <TabsContent value="token" className="mt-4">
            <McpBody
              client={client}
              mcpUrl={mcpUrl}
              token="archestra_TOKEN"
              serverName={serverName}
              gatewayId={gatewayId}
              isQuick={isQuick}
            />
          </TabsContent>
        </Tabs>
      ) : authMethod === "oauth" ? (
        <McpBody
          client={client}
          mcpUrl={mcpUrl}
          token={null}
          serverName={serverName}
          gatewayId={gatewayId}
          isQuick={isQuick}
        />
      ) : (
        <McpBody
          client={client}
          mcpUrl={mcpUrl}
          token="archestra_TOKEN"
          serverName={serverName}
          gatewayId={gatewayId}
          isQuick={isQuick}
        />
      )}
    </div>
  );
}

interface McpBodyProps {
  client: ConnectClient;
  mcpUrl: string;
  token: string | null;
  serverName: string;
  gatewayId: string;
  isQuick: boolean;
}

function McpBody({
  client,
  mcpUrl,
  token,
  serverName,
  gatewayId,
  isQuick,
}: McpBodyProps) {
  if (client.mcp.kind === "generic") {
    return (
      <div className="space-y-3">
        <FieldRow label="URL" value={mcpUrl} />
        {token && <GenericAuthRow gatewayId={gatewayId} placeholder={token} />}
      </div>
    );
  }

  if (client.mcp.kind !== "custom") return null;

  const mcp = client.mcp;
  const ctaParams: McpBuildParams = { url: mcpUrl, token, serverName };
  const cta = mcp.cta;
  const ctaHref = cta?.buildHref(ctaParams);

  if (isQuick && cta && ctaHref) {
    return <DeeplinkHero client={client} href={ctaHref} label={cta.label} />;
  }

  const steps =
    typeof mcp.steps === "function" ? mcp.steps(ctaParams) : mcp.steps;
  const hasStepCommands = steps.some((s) => !!s.buildCommand);
  const stepsHaveAuthHeader = steps.some((s) => s.showAuthHeader);

  if (hasStepCommands) {
    return (
      <div className="space-y-4">
        {cta && ctaHref && (
          <DeeplinkHero client={client} href={ctaHref} label={cta.label} />
        )}
        <ol className="grid gap-5">
          {steps.map((s, i) => (
            <li
              key={s.title}
              className="grid grid-cols-[22px_1fr] items-start gap-3"
            >
              <div className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                {i + 1}
              </div>
              <div className="min-w-0 space-y-3">
                <div>
                  <div className="text-[13.5px] font-medium text-foreground">
                    {s.title}
                  </div>
                  {s.body && (
                    <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                      {s.body}
                    </div>
                  )}
                </div>
                {s.buildCommand && (
                  <TerminalBlock code={s.buildCommand(ctaParams)} />
                )}
                {s.showAuthHeader && token && (
                  <GenericAuthRow
                    gatewayId={gatewayId}
                    placeholder={token}
                    bare={s.authHeaderBare}
                  />
                )}
              </div>
            </li>
          ))}
        </ol>
        {token && !stepsHaveAuthHeader && (
          <GenericAuthRow gatewayId={gatewayId} placeholder={token} />
        )}
      </div>
    );
  }

  // biome-ignore lint/style/noNonNullAssertion: buildConfig is required when reaching this branch (non-quick custom mcp)
  const configCode = mcp.buildConfig!(ctaParams);

  return (
    <div className="space-y-4">
      {cta && ctaHref && (
        <DeeplinkHero client={client} href={ctaHref} label={cta.label} />
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[320px_1fr]">
        <ol className="grid gap-3.5">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <div className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                {i + 1}
              </div>
              <div>
                <div className="text-[13.5px] font-medium text-foreground">
                  {s.title}
                </div>
                {s.body && (
                  <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                    {s.body}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>

        <TerminalBlock code={configCode} />
      </div>
    </div>
  );
}

/**
 * Deeplink hero — dark gradient card with a white CTA button on the right.
 * Mirrors the "One-click install" card from the mockup (`instructions.jsx`).
 */
function DeeplinkHero({
  client,
  href,
  label,
}: {
  client: ConnectClient;
  href: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-2xl bg-gradient-to-br from-[#1e1b4b] to-[#27254a] px-5 py-4 text-white shadow-lg">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5">
        {client.svg ? (
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            role="img"
            aria-label={`${client.label} logo`}
          >
            <path d={client.svg} fill="#fff" />
          </svg>
        ) : (
          <span className="text-lg font-bold">⚡</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold tracking-tight">
          One-click install
        </div>
        <div className="text-[12px] text-white/70">
          Launches {client.label} with the gateway pre-configured.
        </div>
      </div>
      <a
        href={href}
        className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-[#1e1b4b] no-underline transition-transform hover:-translate-y-0.5"
      >
        <ExternalLink className="size-3.5" strokeWidth={2.2} />
        {label}
      </a>
    </div>
  );
}

const PERSONAL_TOKEN_ID = "__personal__";

/**
 * Auth-header row for the generic "Any Client" flow. Lets the user pick
 * which token (personal / team / org) to embed, and reveal the real value
 * on demand.
 */
function GenericAuthRow({
  gatewayId,
  placeholder,
  bare = false,
}: {
  gatewayId: string;
  placeholder: string;
  /** When true, render just the raw token (no `Bearer ` prefix). Used by clients
   *  whose credential UI prepends the scheme automatically (e.g. n8n Bearer Auth). */
  bare?: boolean;
}) {
  const { data: userToken } = useUserToken();
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: tokensData } = useTokens({
    profileId: gatewayId,
    enabled: !!canReadTeams,
  });
  const tokens = tokensData?.tokens ?? [];

  // Mirror the original defaulting logic: personal > org > first team token.
  const orgToken = tokens.find((t) => t.isOrganizationToken);
  const defaultTokenId: string | null = userToken
    ? PERSONAL_TOKEN_ID
    : (orgToken?.id ?? tokens[0]?.id ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(defaultTokenId);
  useEffect(() => {
    if (selectedId === null && defaultTokenId) setSelectedId(defaultTokenId);
  }, [selectedId, defaultTokenId]);

  const [exposedValue, setExposedValue] = useState<string | null>(null);
  const fetchUserTokenMutation = useFetchUserTokenValue();
  const fetchTeamTokenMutation = useFetchTeamTokenValue();
  const isLoading =
    fetchUserTokenMutation.isPending || fetchTeamTokenMutation.isPending;

  const isPersonal = selectedId === PERSONAL_TOKEN_ID;
  const selectedTeamToken = isPersonal
    ? null
    : (tokens.find((t) => t.id === selectedId) ?? null);

  const selectedLabel = isPersonal
    ? "Personal Token"
    : selectedTeamToken
      ? selectedTeamToken.isOrganizationToken
        ? "Organization Token"
        : selectedTeamToken.team?.name
          ? `Team Token (${selectedTeamToken.team.name})`
          : selectedTeamToken.name
      : "Select token";
  const _selectedDescription = isPersonal
    ? "The most secure option."
    : selectedTeamToken?.isOrganizationToken
      ? "To share org-wide"
      : "To share with your teammates";

  const previewValue = exposedValue
    ? exposedValue
    : isPersonal && userToken
      ? `${userToken.tokenStart}***`
      : selectedTeamToken
        ? `${selectedTeamToken.tokenStart}***`
        : placeholder;

  const handleToggleExpose = async () => {
    if (exposedValue) {
      setExposedValue(null);
      return;
    }
    if (isPersonal) {
      const res = await fetchUserTokenMutation.mutateAsync();
      if (res?.value) setExposedValue(res.value);
    } else if (selectedTeamToken) {
      const res = await fetchTeamTokenMutation.mutateAsync(
        selectedTeamToken.id,
      );
      if (res?.value) setExposedValue(res.value);
    }
  };

  const hasAnyToken = !!userToken || tokens.length > 0;
  const headerValue = bare ? previewValue : `Bearer ${previewValue}`;
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(headerValue);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const teamTokens = tokens.filter((t) => !t.isOrganizationToken);
  const orgTokens = tokens.filter((t) => t.isOrganizationToken);

  if (!hasAnyToken) {
    return (
      <div className="text-xs text-muted-foreground">
        No tokens available — provision one from{" "}
        <Link
          href="/settings/account?tab=tokens"
          className="underline hover:text-foreground"
        >
          your account
        </Link>
        .
      </div>
    );
  }

  return (
    <DropdownMenu>
      <div className="relative overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <button
            type="button"
            onClick={handleToggleExpose}
            disabled={isLoading}
            aria-label={exposedValue ? "Hide token" : "Reveal token"}
            className="flex size-7 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white disabled:opacity-50"
          >
            {isLoading ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
            ) : exposedValue ? (
              <EyeOff className="size-3.5" strokeWidth={2} />
            ) : (
              <Eye className="size-3.5" strokeWidth={2} />
            )}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy to clipboard"
            className="flex size-7 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white"
          >
            {copied ? (
              <Check className="size-3.5 text-[#4ade80]" strokeWidth={2.5} />
            ) : (
              <Copy className="size-3.5" strokeWidth={2} />
            )}
          </button>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Switch token"
              className="flex h-7 items-center gap-1 rounded border border-[#1f2937] bg-[#0d1117] px-2 text-[11px] text-[#9ca3af] transition-colors hover:text-white"
            >
              {selectedLabel}
              <ChevronDown className="size-3" strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
        </div>
        <pre className="m-0 overflow-auto px-5 py-4 pr-36 font-mono text-[13px] leading-[1.65] text-[#e5e7eb]">
          {headerValue}
        </pre>
      </div>
      <DropdownMenuContent align="end" className="w-[280px]">
        {userToken && (
          <TokenOption
            active={selectedId === PERSONAL_TOKEN_ID}
            label="Personal Token"
            description="The most secure option."
            onSelect={() => {
              setSelectedId(PERSONAL_TOKEN_ID);
              setExposedValue(null);
            }}
          />
        )}
        {teamTokens.map((t) => (
          <TokenOption
            key={t.id}
            active={selectedId === t.id}
            label={t.team?.name ? `Team Token (${t.team.name})` : t.name}
            description="To share with your teammates"
            onSelect={() => {
              setSelectedId(t.id);
              setExposedValue(null);
            }}
          />
        ))}
        {orgTokens.map((t) => (
          <TokenOption
            key={t.id}
            active={selectedId === t.id}
            label="Organization Token"
            description="To share org-wide"
            onSelect={() => {
              setSelectedId(t.id);
              setExposedValue(null);
            }}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TokenOption({
  active,
  label,
  description,
  onSelect,
}: {
  active: boolean;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn("flex flex-col items-start gap-0.5", active && "bg-accent")}
    >
      <span>{label}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </DropdownMenuItem>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3 rounded-lg border bg-card px-4 py-3">
      <div className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <CopyableCode
        value={value}
        variant="primary"
        className="min-w-0 overflow-hidden"
      />
    </div>
  );
}

export function ClientHeader({
  client,
  title,
  subtitle,
}: {
  client: ConnectClient;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <ClientIcon client={client} size={36} />
      <div className="min-w-0">
        <div className="text-[22px] font-bold leading-tight tracking-tight text-foreground">
          {title}
        </div>
        <div className="mt-0.5 text-[13px] text-muted-foreground">
          {subtitle}
        </div>
      </div>
    </div>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

export function UnsupportedPanel({ reason }: { reason: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" strokeWidth={2.2} />
      <div className="text-sm leading-relaxed">{reason}</div>
    </div>
  );
}
