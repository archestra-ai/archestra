"use client";

import {
  EXTERNAL_AGENT_ID_HEADER,
  isSupportedProvider,
  providerDisplayNames,
  type SupportedProvider,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { AlertTriangle, Check, Copy, Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyableCode } from "@/components/copyable-code";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCreateConnectionPassthroughKey } from "@/lib/connection-setup.query";
import { cn } from "@/lib/utils";
import type { ConnectClient, ProxyStep } from "./clients";
import { UnsupportedPanel } from "./mcp-client-instructions";
import { TerminalBlock } from "./terminal-block";
import { useUpdateUrlParams } from "./use-update-url-params";

/** Compact provider tile — colored square with a short glyph or letter. */
const PROVIDER_ICONS: Record<
  SupportedProvider,
  { bg: string; fg: string; glyph: string }
> = {
  openai: { bg: "#10a37f", fg: "#fff", glyph: "◎" },
  anthropic: { bg: "#D97757", fg: "#fff", glyph: "A" },
  gemini: {
    bg: "linear-gradient(135deg, #4285f4 0%, #9b72cb 50%, #d96570 100%)",
    fg: "#fff",
    glyph: "✦",
  },
  bedrock: { bg: "#232f3e", fg: "#ff9900", glyph: "aws" },
  azure: { bg: "#0078d4", fg: "#fff", glyph: "▲" },
  groq: { bg: "#f55036", fg: "#fff", glyph: "G" },
  cerebras: { bg: "#ff4d1c", fg: "#fff", glyph: "◆" },
  openrouter: { bg: "#1e1b4b", fg: "#fff", glyph: "↯" },
  ollama: { bg: "#fff1ea", fg: "#1e1b4b", glyph: "◎" },
  vllm: { bg: "#fafaff", fg: "#1e1b4b", glyph: "◇" },
  cohere: { bg: "#ff7759", fg: "#fff", glyph: "c" },
  mistral: { bg: "#ff7000", fg: "#fff", glyph: "M" },
  perplexity: { bg: "#20808d", fg: "#fff", glyph: "✳" },
  xai: { bg: "#000", fg: "#fff", glyph: "X" },
  deepseek: { bg: "#4d6bfe", fg: "#fff", glyph: "D" },
  minimax: { bg: "#0ea5a4", fg: "#fff", glyph: "M" },
  zhipuai: { bg: "#dc2626", fg: "#fff", glyph: "Z" },
  "github-copilot": { bg: "#24292f", fg: "#fff", glyph: "gh" },
};

/** Original upstream base URLs — shown struck through next to the proxy URL. */
const PROVIDER_ORIGINAL_URLS: Record<SupportedProvider, string> = {
  openai: "https://api.openai.com/v1/",
  anthropic: "https://api.anthropic.com/v1/",
  gemini: "https://generativelanguage.googleapis.com/",
  bedrock: "https://bedrock-runtime.<region>.amazonaws.com/",
  azure: "https://<resource>.openai.azure.com/",
  groq: "https://api.groq.com/openai/v1/",
  cerebras: "https://api.cerebras.ai/v1/",
  openrouter: "https://openrouter.ai/api/v1/",
  ollama: "http://localhost:11434/v1/",
  vllm: "http://<host>:8000/v1/",
  cohere: "https://api.cohere.com/v2/",
  mistral: "https://api.mistral.ai/v1/",
  perplexity: "https://api.perplexity.ai/",
  xai: "https://api.x.ai/v1/",
  deepseek: "https://api.deepseek.com/",
  minimax: "https://api.minimax.io/v1/",
  zhipuai: "https://open.bigmodel.cn/api/",
  "github-copilot": "https://api.githubcopilot.com/",
};

interface ProxyClientInstructionsProps {
  client: ConnectClient;
  profileId: string;
  /** Display name of the LLM proxy (profile) — used as a provider id in client configs. */
  profileName: string;
  /** When null/undefined: show all providers. Otherwise: only these. */
  shownProviders?: readonly SupportedProvider[] | null;
  /** Connection base URL chosen at the page level (see ConnectionUrlStep). */
  baseUrl: string;
}

const ALL_PROVIDERS = Object.keys(providerDisplayNames) as SupportedProvider[];

/**
 * Slugify the LLM proxy name into a TOML-friendly identifier (e.g. used as
 * `[model_providers.<slug>]` in Codex's config).
 */
function toProxyProviderSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "archestra";
}

export function ProxyClientInstructions({
  client,
  profileId,
  profileName,
  shownProviders,
  baseUrl,
}: ProxyClientInstructionsProps) {
  const shownSet = useMemo(
    () => (shownProviders ? new Set(shownProviders) : null),
    [shownProviders],
  );
  const isShown = useCallback(
    (p: SupportedProvider) => !shownSet || shownSet.has(p),
    [shownSet],
  );

  const searchParams = useSearchParams();
  const urlProvider = searchParams.get("providerId");
  const updateUrlParams = useUpdateUrlParams();
  const updateProviderInUrl = useCallback(
    (value: string | null) => updateUrlParams({ providerId: value }),
    [updateUrlParams],
  );

  const rawSupportedProviders = useMemo(
    () =>
      client.proxy.kind === "custom"
        ? client.proxy.supportedProviders
        : client.proxy.kind === "generic"
          ? ALL_PROVIDERS
          : [],
    [client.proxy],
  );
  const supportedProviders = useMemo(
    () => rawSupportedProviders.filter(isShown),
    [rawSupportedProviders, isShown],
  );
  const visibleAllProviders = useMemo(
    () => ALL_PROVIDERS.filter(isShown),
    [isShown],
  );

  // Drive selection off the URL so client switches (which clear providerId in
  // the URL) immediately reset the picker without stale local state.
  const selectedProvider: SupportedProvider | null =
    urlProvider && isSupportedProvider(urlProvider) && isShown(urlProvider)
      ? urlProvider
      : null;

  // Auto-select the sole supported provider when the card opens for a client
  // that only supports one option, so the user doesn't have to click it.
  useEffect(() => {
    if (!selectedProvider && supportedProviders.length === 1) {
      updateProviderInUrl(supportedProviders[0]);
    }
  }, [selectedProvider, supportedProviders, updateProviderInUrl]);

  const handleProviderSelect = (p: SupportedProvider) => {
    updateProviderInUrl(p);
  };

  const providerLabel = selectedProvider
    ? providerDisplayNames[selectedProvider]
    : null;
  const url = selectedProvider
    ? `${baseUrl}/${selectedProvider}/${profileId}`
    : null;
  const originalUrl = selectedProvider
    ? PROVIDER_ORIGINAL_URLS[selectedProvider]
    : null;
  const isCompatible =
    !!selectedProvider && supportedProviders.includes(selectedProvider);

  const instruction = useMemo(() => {
    if (client.proxy.kind !== "custom") return null;
    if (!selectedProvider || !providerLabel || !url) return null;
    return client.proxy.build({
      provider: selectedProvider,
      providerLabel,
      url,
      tokenPlaceholder: `<your-${selectedProvider}-api-key>`,
      proxyName: toProxyProviderSlug(profileName),
    });
  }, [client.proxy, selectedProvider, providerLabel, url, profileName]);

  if (client.proxy.kind === "unsupported") {
    return <UnsupportedPanel reason={client.proxy.reason} />;
  }

  const gridProviders =
    client.proxy.kind === "generic" ? visibleAllProviders : supportedProviders;
  const rawProviderCount =
    client.proxy.kind === "generic"
      ? ALL_PROVIDERS.length
      : rawSupportedProviders.length;
  const hiddenByAdmin = gridProviders.length === 0 && rawProviderCount > 0;

  if (gridProviders.length === 0) {
    return <NoProvidersPanel client={client} hiddenByAdmin={hiddenByAdmin} />;
  }

  return (
    <div id="proxy-instructions" className="space-y-4">
      <ProviderGrid
        providers={gridProviders}
        supported={supportedProviders}
        selected={selectedProvider}
        onSelect={handleProviderSelect}
      />

      {!selectedProvider ? null : client.proxy.kind === "generic" &&
        url &&
        providerLabel &&
        originalUrl ? (
        selectedProvider === "bedrock" ? (
          <BedrockGenericInstructions
            baseUrl={baseUrl}
            profileId={profileId}
            originalUrl={originalUrl}
          />
        ) : (
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-2.5 text-xs text-muted-foreground">
              Replace the{" "}
              <span className="font-medium text-foreground">
                {providerLabel}
              </span>{" "}
              base URL:
            </div>
            <div className="grid min-w-0 items-center gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div className="min-w-0 overflow-hidden rounded-md border border-dashed bg-muted/40 px-3 py-2">
                <code className="block truncate text-xs line-through opacity-50">
                  {originalUrl}
                </code>
              </div>
              <span className="text-center text-muted-foreground">→</span>
              <CopyableCode
                value={url}
                variant="primary"
                toastMessage="Proxy URL copied"
              />
            </div>
          </div>
        )
      ) : isCompatible && instruction ? (
        instruction.kind === "snippet" ? (
          <div className="space-y-2">
            <TerminalBlock code={instruction.code} />
            {instruction.note && <ProxyNote note={instruction.note} />}
          </div>
        ) : instruction.kind === "steps" ? (
          <div className="space-y-3">
            {instruction.note && <ProxyNote note={instruction.note} />}
            <StepList steps={instruction.steps} llmProxyId={profileId} />
          </div>
        ) : (
          <div className="space-y-6">
            {instruction.sections.map((sec) => (
              <div key={sec.title} className="space-y-3">
                <div>
                  <div className="text-[14px] font-semibold text-foreground">
                    {sec.title}
                  </div>
                  {sec.description && (
                    <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                      {sec.description}
                    </div>
                  )}
                </div>
                <StepList steps={sec.steps} llmProxyId={profileId} />
              </div>
            ))}
            {instruction.note && <ProxyNote note={instruction.note} />}
          </div>
        )
      ) : (
        <UnsupportedPanel
          reason={`${client.label} doesn't support this provider.`}
        />
      )}
    </div>
  );
}

function BedrockGenericInstructions({
  baseUrl,
  profileId,
  originalUrl,
}: {
  baseUrl: string;
  profileId: string;
  originalUrl: string;
}) {
  const converseUrl = `${baseUrl}/bedrock/${profileId}`;
  const openaiUrl = `${baseUrl}/bedrock/openai/${profileId}`;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-4">
        <div className="mb-1 text-[13px] font-medium text-foreground">
          Bedrock Converse API
        </div>
        <div className="mb-2.5 text-xs text-muted-foreground">
          Replace Bedrock Base URL.
        </div>
        <div className="grid min-w-0 items-center gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="min-w-0 overflow-hidden rounded-md border border-dashed bg-muted/40 px-3 py-2">
            <code className="block truncate text-xs line-through opacity-50">
              {originalUrl}
            </code>
          </div>
          <span className="text-center text-muted-foreground">→</span>
          <CopyableCode
            value={converseUrl}
            variant="primary"
            toastMessage="Proxy URL copied"
          />
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="mb-1 text-[13px] font-medium text-foreground">
          <a
            href="https://platform.openai.com/docs/api-reference/chat"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            OpenAI Completions API
          </a>{" "}
          compatible endpoint
        </div>
        <div className="mb-2.5 text-xs text-muted-foreground">
          Replace your OpenAI endpoint to connect OpenAI Completions API
          compatible client to{" "}
          <a
            href="https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            Bedrock Converse API
          </a>
          .
        </div>
        <div className="grid min-w-0 items-center gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="min-w-0 overflow-hidden rounded-md border border-dashed bg-muted/40 px-3 py-2">
            <code className="block truncate text-xs line-through opacity-50">
              https://api.openai.com/v1/
            </code>
          </div>
          <span className="text-center text-muted-foreground">→</span>
          <CopyableCode
            value={openaiUrl}
            variant="primary"
            toastMessage="Proxy URL copied"
          />
        </div>
      </div>
    </div>
  );
}

function NoProvidersPanel({
  client,
  hiddenByAdmin,
}: {
  client: ConnectClient;
  hiddenByAdmin: boolean;
}) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      <div className="font-medium text-foreground">
        No providers available for {client.label}
      </div>
      <p className="mt-1">
        {hiddenByAdmin
          ? "Your admin hasn't enabled any of the providers this client supports."
          : "This client doesn't support any providers that are currently enabled."}
      </p>
    </div>
  );
}

function StepList({
  steps,
  llmProxyId,
}: {
  steps: ProxyStep[];
  /** LLM proxy the setup targets — needed to provision a passthrough key. */
  llmProxyId: string;
}) {
  return (
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
            {s.fields && s.fields.length > 0 && (
              <div className="grid gap-2">
                {s.fields.map((f) => (
                  <FieldRow
                    key={f.label}
                    label={f.label}
                    value={f.value}
                    copyable={f.copyable ?? true}
                  />
                ))}
              </div>
            )}
            {s.showPassthroughKey && (
              <PassthroughKeyField
                llmProxyId={llmProxyId}
                variant={s.passthroughKeyVariant ?? "header"}
                agentId={s.passthroughKeyAgentId}
              />
            )}
            {s.code && <TerminalBlock code={s.code} />}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Inline reveal for the manual attribution step: auto-provisions the caller's
 * personal passthrough virtual key (scoped to this proxy) and shows the header
 * name + copyable value to paste into the client's custom-headers field. Gated
 * on llmVirtualKey:create; otherwise points to the Virtual API Keys page.
 */
type PassthroughKeyState =
  | { status: "loading" }
  | { status: "done"; key: { value: string; name: string } }
  | { status: "error" };

function PassthroughKeyField({
  llmProxyId,
  variant,
  agentId,
}: {
  llmProxyId: string;
  variant: "header" | "env";
  /**
   * Optional client-attribution value sent as the X-Archestra-Agent-Id header
   * alongside the passthrough key (e.g. "anthropic_claude_code" / "anthropic_claude_desktop"). Not a
   * secret — shown in full.
   */
  agentId?: string;
}) {
  const { data: canCreate } = useHasPermissions({ llmVirtualKey: ["create"] });
  const { mutateAsync } = useCreateConnectionPassthroughKey();
  const [state, setState] = useState<PassthroughKeyState>({
    status: "loading",
  });

  // ensureConnectionPassthroughKey is idempotent server-side, so a single fire
  // is enough; always settle into done/error (never leave a dangling spinner —
  // an earlier cancelled-flag version could strand the UI on success).
  const runProvision = useCallback(() => {
    setState({ status: "loading" });
    mutateAsync({ llmProxyId })
      .then((result) =>
        setState(
          result ? { status: "done", key: result } : { status: "error" },
        ),
      )
      .catch(() => setState({ status: "error" }));
  }, [mutateAsync, llmProxyId]);

  // Auto-provision once the permission resolves. The ref fires exactly once and
  // survives React strict-mode's double-invoke.
  const firedRef = useRef(false);
  useEffect(() => {
    if (canCreate !== true || firedRef.current) return;
    firedRef.current = true;
    runProvision();
  }, [canCreate, runProvision]);

  if (canCreate === false) {
    return (
      <p className="text-[12.5px] leading-snug text-muted-foreground">
        Create a passthrough virtual key on the{" "}
        <Link
          href="/llm/credentials/virtual-keys"
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          Virtual API Keys
        </Link>{" "}
        page, then add a header named{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
          {VIRTUAL_KEY_HEADER}
        </code>{" "}
        with the key as its value.
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p className="text-[12.5px] leading-snug text-muted-foreground">
        Couldn&apos;t create a passthrough key.{" "}
        <button
          type="button"
          onClick={runProvision}
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          Retry
        </button>{" "}
        or create one on the{" "}
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

  if (state.status !== "done") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Creating your passthrough key…
      </div>
    );
  }

  const { key } = state;
  // The agent-id line (non-secret) rides in the same ANTHROPIC_CUSTOM_HEADERS
  // value (env) or as its own header row (header), one "Name: Value" per line.
  const agentIdLine = agentId
    ? `${EXTERNAL_AGENT_ID_HEADER}: ${agentId}`
    : null;
  return (
    <div className="grid gap-2">
      {variant === "env" ? (
        // Paste as the ANTHROPIC_CUSTOM_HEADERS value. The key is a secret, so
        // it is masked on screen and copied in full; the agent-id is shown as-is.
        <StackedCopyField
          label="ANTHROPIC_CUSTOM_HEADERS"
          display={[agentIdLine, `${VIRTUAL_KEY_HEADER}: ${SECRET_MASK}`]
            .filter(Boolean)
            .join("\n")}
          copyValue={[agentIdLine, `${VIRTUAL_KEY_HEADER}: ${key.value}`]
            .filter(Boolean)
            .join("\n")}
        />
      ) : (
        <>
          {agentIdLine && (
            <StackedCopyField
              label="Header"
              display={EXTERNAL_AGENT_ID_HEADER}
              copyValue={EXTERNAL_AGENT_ID_HEADER}
            />
          )}
          {agentIdLine && (
            <StackedCopyField
              label="Value"
              display={agentId ?? ""}
              copyValue={agentId ?? ""}
            />
          )}
          <StackedCopyField
            label="Header"
            display={VIRTUAL_KEY_HEADER}
            copyValue={VIRTUAL_KEY_HEADER}
          />
          <StackedCopyField
            label="Value"
            display={SECRET_MASK}
            copyValue={key.value}
          />
        </>
      )}
      <p className="text-[11px] text-muted-foreground">
        Revoke any time by deleting the &quot;{key.name}&quot; key on the
        Virtual API Keys page.
      </p>
    </div>
  );
}

/** Mask shown in place of a secret value (the real value is only copied). */
const SECRET_MASK = "•".repeat(20);

/**
 * Stacked label + value with a copy button. `display` is what's shown on screen
 * (a mask for secrets); `copyValue` is what's written to the clipboard. The
 * stacked layout avoids the cramped fixed-width FieldRow label column.
 */
function StackedCopyField({
  label,
  display,
  copyValue,
}: {
  label: string;
  display: string;
  copyValue: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-mono text-[11px] font-medium uppercase tracking-wider text-[#9ca3af]">
            {label}
          </div>
          <code className="block truncate font-mono text-[13px] text-[#e5e7eb]">
            {display}
          </code>
        </div>
        <FieldCopyButton value={copyValue} />
      </div>
    </div>
  );
}

function FieldRow({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string;
  copyable: boolean;
}) {
  if (!copyable) {
    return (
      <div className="grid grid-cols-[140px_1fr] items-center gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-3">
        <div className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <span className="min-w-0 truncate text-[13px] italic text-muted-foreground">
          {value}
        </span>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
      <div className="grid grid-cols-[140px_1fr_auto] items-center gap-3 px-4 py-3">
        <div className="font-mono text-[11px] font-medium uppercase tracking-wider text-[#9ca3af]">
          {label}
        </div>
        <code className="min-w-0 truncate font-mono text-[13px] text-[#e5e7eb]">
          {value}
        </code>
        <FieldCopyButton value={value} />
      </div>
    </div>
  );
}

function FieldCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label="Copy to clipboard"
      className="flex size-7 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white"
    >
      {copied ? (
        <Check className="size-3.5 text-[#4ade80]" strokeWidth={2.5} />
      ) : (
        <Copy className="size-3.5" strokeWidth={2} />
      )}
    </button>
  );
}

function ProxyNote({ note }: { note: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[12.5px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{note}</span>
    </div>
  );
}

interface ProviderGridProps {
  providers: SupportedProvider[];
  supported: SupportedProvider[];
  selected: SupportedProvider | null;
  onSelect: (p: SupportedProvider) => void;
}

function ProviderGrid({
  providers,
  supported,
  selected,
  onSelect,
}: ProviderGridProps) {
  const PRIMARY: SupportedProvider[] = [
    "openai",
    "anthropic",
    "gemini",
    "bedrock",
    "groq",
  ];
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const compact = providers.filter((p) => PRIMARY.includes(p));
  // If the admin's allow-list excludes every primary provider, there's
  // nothing to collapse to — fall through to the full list instead of
  // rendering an empty grid behind a "Show all" button.
  const canCollapse = compact.length > 0 && compact.length < providers.length;
  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  // When searching, ignore the compact/expanded toggle and search all providers.
  const base = searching || showAll || !canCollapse ? providers : compact;
  const visible = searching
    ? base.filter((p) =>
        providerDisplayNames[p].toLowerCase().includes(normalizedQuery),
      )
    : base;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
        <h3 className="text-[17px] font-bold tracking-tight text-foreground">
          Select a provider
        </h3>
        {canCollapse && (
          <div className="flex items-center gap-3">
            {!searching && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 text-xs"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? "Show fewer" : `Show all (${providers.length})`}
              </Button>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="h-9 w-56 rounded-full pl-8"
              />
            </div>
          </div>
        )}
      </div>
      {searching && visible.length === 0 && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-center text-xs text-muted-foreground">
          No providers match "{query}".
        </div>
      )}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
        {visible.map((p) => {
          const isSupported = supported.includes(p);
          const isSel = selected === p;
          const icon = PROVIDER_ICONS[p];
          return (
            <button
              key={p}
              type="button"
              onClick={() => onSelect(p)}
              className={cn(
                "relative flex items-center gap-3 rounded-lg border bg-card p-3 text-left shadow-sm transition-all hover:border-primary/50",
                isSel && "border-primary ring-4 ring-primary/5",
                !isSupported && "opacity-50",
              )}
            >
              <div
                className="flex size-9 shrink-0 items-center justify-center rounded-md font-mono text-[13px] font-bold"
                style={{ background: icon.bg, color: icon.fg }}
              >
                {icon.glyph === "aws" ? (
                  <span className="text-[9px] font-extrabold tracking-tight">
                    aws
                  </span>
                ) : (
                  icon.glyph
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold tracking-tight text-foreground">
                  {providerDisplayNames[p]}
                </div>
                {!isSupported && (
                  <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                    Not compatible
                  </div>
                )}
              </div>
              {isSel && (
                <div className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-2.5" strokeWidth={3} />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
