"use client";

import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileJson,
  Globe,
  KeyRound,
  Layers,
  Lock,
  Server,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type UseFormReturn, useFormState } from "react-hook-form";
import { toast } from "sonner";
import { Editor } from "@/components/editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { LOCAL_MCP_DISABLED_MESSAGE } from "@/consts";
import { copyToClipboard } from "@/lib/clipboard";
import { useFeature } from "@/lib/config/config.query";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import {
  type ApplyPlan,
  computeApplyChanges,
  connectionServerKey,
  revertApplyChanges,
} from "./mcp-config-changes";
import {
  applyImportedServerToForm,
  canExportRegistryJson,
  canExportServersJson,
  type ImportedMcpServer,
  type McpJsonExportFormat,
  mcpJsonExportFileName,
  parseMcpConfigText,
  serializeFormValuesToMcpJson,
} from "./mcp-config-import";
import { McpJsonFormatSelect } from "./mcp-json-format-select";

const EDITOR_PLACEHOLDER = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "<token>" }
    }
  }
}`;

/** Imperative surface the form uses to route external events into the panel. */
export interface ConnectionJsonPanelController {
  /**
   * Expand the panel, load an intercepted field paste as the pending draft,
   * and bring the panel into view for review.
   */
  reviewPaste: (pastedText: string) => void;
  /**
   * Expand the panel and bring it into view without touching its text — used
   * by the submit guard when an unapplied draft blocks saving.
   */
  reveal: () => void;
}

/**
 * The Connection card's embedded "Import & export" block — the one JSON
 * surface.
 *
 * While untouched it is a live mirror: every form edit re-serializes into the
 * chosen export format, so the form ↔ JSON round-trip is always visible (copy
 * or download it from here). The moment the text is edited or a config is
 * pasted, the mirror freezes into a pending draft and the reviewed import
 * pipeline takes over: parse, preview, an exact changes list (computed by
 * running the real apply against a shadow copy), then an explicit Apply.
 * Nothing touches the form before Apply; Discard reseeds from the form
 * without a trace. The receipt toast carries a path-scoped Undo that restores
 * only the fields the apply touched. Collapsing hides the block but keeps its
 * state; a pending draft stays flagged in the header.
 */
export function ConnectionJsonPanel({
  form,
  mode,
  storedSecretValues,
  appName,
  controllerRef,
  onDraftStateChange,
}: {
  form: UseFormReturn<McpCatalogFormValues>;
  mode: "create" | "edit";
  /** Hydrated stored secret values (edit mode) — masked by value identity. */
  storedSecretValues?: Record<string, string>;
  appName: string;
  controllerRef?: React.MutableRefObject<ConnectionJsonPanelController | null>;
  /**
   * Reports whether an unapplied draft exists (text diverged from the form).
   * The form gates submission on it so JSON edits are never silently lost.
   */
  onDraftStateChange?: (hasPendingDraft: boolean) => void;
}) {
  const isLocalMcpEnabled = useFeature("orchestratorK8sRuntime");
  const [collapsed, setCollapsed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // Export format of the mirrored view — every option round-trips through the
  // import parser. While the text is a pending draft, the displayed format is
  // the detected one instead (see effectiveFormat below).
  const [exportFormat, setExportFormat] =
    useState<McpJsonExportFormat>("mcpServers");

  const serializeCurrent = (format: McpJsonExportFormat) =>
    serializeFormValuesToMcpJson(form.getValues(), {
      storedSecretValues,
      format,
    });

  // The serialized current config the editor mirrors. An empty form seeds
  // too: the serializer emits a skeleton entry (e.g. `"url": ""`), so
  // create-from-scratch shows the exact same anatomy as an edit. While the
  // text still equals it there is nothing to apply — the editor is a viewer.
  const [seededText, setSeededText] = useState<string>(() =>
    serializeCurrent("mcpServers"),
  );
  const [text, setText] = useState<string>(seededText);

  // Untouched = still mirroring the form. The import pipeline (preview,
  // changes, Apply/Discard) stays hidden in this state.
  const untouched = text === seededText;

  // A form edit can invalidate the chosen export format mid-mirror (VS Code
  // selected, then a Docker image typed in — or the server type flipped).
  // Resolve to the universal mcpServers view instead of mirroring a format
  // whose own select entry is disabled.
  const resolveExportFormat = (
    format: McpJsonExportFormat,
  ): McpJsonExportFormat => {
    const values = form.getValues();
    if (format === "servers" && !canExportServersJson(values)) {
      return "mcpServers";
    }
    if (format === "registry" && !canExportRegistryJson(values)) {
      return "mcpServers";
    }
    return format;
  };

  // Values-change render trigger: the panel lives INSIDE the form, so the
  // form stays editable around it at all times (unlike the old modal, which
  // blocked the form while open). Every form change must re-render the panel
  // so the mirror and the pending-draft plan below stay fresh.
  const [, setFormTick] = useState(0);
  useEffect(() => {
    const subscription = form.watch(() => setFormTick((tick) => tick + 1));
    return () => subscription.unsubscribe();
  }, [form]);

  // Live-follow, as a render-phase state adjustment (React's sanctioned
  // alternative to a mirroring effect): while untouched, the text tracks the
  // form — in the still-valid resolution of the chosen format. A pending
  // draft never reseeds — the user's paste/edit is frozen until Apply or
  // Discard.
  if (untouched) {
    const resolvedFormat = resolveExportFormat(exportFormat);
    if (resolvedFormat !== exportFormat) setExportFormat(resolvedFormat);
    const liveSeed = serializeCurrent(resolvedFormat);
    if (liveSeed !== text) {
      setText(liveSeed);
      setSeededText(liveSeed);
    }
  }

  const seedFromForm = (format: McpJsonExportFormat) => {
    // Same resolution on explicit reseeds (Discard/Apply): the form may have
    // changed under a draft in a way that invalidates the remembered format.
    const resolved = resolveExportFormat(format);
    if (resolved !== exportFormat) setExportFormat(resolved);
    const seeded = serializeCurrent(resolved);
    setText(seeded);
    setSeededText(seeded);
    setSelectedIndex(null);
  };

  const parseResult = useMemo(() => parseMcpConfigText(text), [text]);
  const servers: ImportedMcpServer[] =
    parseResult.status === "servers" ? parseResult.servers : [];
  // The export format matching a pasted config, when it is one of the three.
  const detectedFormat =
    parseResult.status === "servers" ? (parseResult.format ?? null) : null;

  const lockedType = mode === "edit" ? form.getValues("serverType") : null;
  const isCompatible = (server: ImportedMcpServer) =>
    lockedType === null || server.values.serverType === lockedType;
  const compatibleCount = servers.filter(isCompatible).length;

  // A single pasted server needs no explicit pick; multi-server pastes start
  // unselected so partial application is always a conscious choice.
  const effectiveIndex = servers.length === 1 ? 0 : (selectedIndex ?? null);
  const selectedServer =
    effectiveIndex !== null ? (servers[effectiveIndex] ?? null) : null;
  const selectedIsCompatible =
    selectedServer !== null && isCompatible(selectedServer);
  const selectedIsLocalButDisabled =
    mode === "create" &&
    selectedServer?.values.serverType === "local" &&
    !isLocalMcpEnabled;

  // Subscribed form state: `form` is a prop, so bare form.formState reads
  // would only be as fresh as whatever happened to re-render this panel.
  const {
    errors: formErrors,
    dirtyFields,
    isDirty: formIsDirty,
  } = useFormState({ control: form.control });

  // The deployment transport is someone's decision once we are editing an
  // existing server, or once any transport field was touched on the create
  // form (including by an earlier apply) — then a stdio-shaped paste leaves
  // it alone. On a pristine create form the paste defines the transport.
  const dirtyLocalConfig = dirtyFields.localConfig;
  const transportConfigured =
    mode === "edit" ||
    Boolean(
      dirtyLocalConfig?.transportType ||
        dirtyLocalConfig?.httpPort ||
        dirtyLocalConfig?.httpPath,
    );

  // Computed per render, not memoized: the form is editable beneath a pending
  // draft, so the plan must follow every form change (the tick above
  // re-renders on each one) — a memo would need the tick as an unused
  // dependency to stay fresh.
  const plan: ApplyPlan | null =
    !untouched && selectedServer && selectedIsCompatible
      ? computeApplyChanges({
          current: form.getValues(),
          server: selectedServer,
          allowServerTypeChange: mode === "create",
          transportConfigured,
        })
      : null;

  // Fresh on every render for the same reason (the tick re-renders on each
  // form change) — one read serves the format gates and the callouts below.
  const currentValues = form.getValues();

  // What the format select shows: the chosen export format while mirroring,
  // the DETECTED format once a config is pasted — recognition is automatic,
  // the select just reflects the text.
  const effectiveFormat = untouched
    ? exportFormat
    : (detectedFormat ?? "mcpServers");
  // Untouched: switching the format re-serializes the form. A pending draft
  // with a single recognized server: switching CONVERTS the pasted config
  // into the chosen format (via the parsed values — same masking rules as
  // any export, so literal secrets become install-time prompts).
  const handleFormatChange = (format: McpJsonExportFormat) => {
    if (untouched) {
      // seedFromForm owns the exportFormat state update (post-resolution).
      seedFromForm(format);
    } else if (servers.length === 1) {
      setText(serializeFormValuesToMcpJson(servers[0].values, { format }));
    }
  };
  // Which formats are validly exportable — gated on the form while mirroring,
  // on the pasted server once converting.
  const formatGateValues = untouched
    ? currentValues
    : servers.length === 1
      ? servers[0].values
      : null;
  const formatDisabledReasons: Partial<Record<McpJsonExportFormat, string>> =
    formatGateValues
      ? {
          ...(canExportRegistryJson(formatGateValues)
            ? {}
            : { registry: "needs an npx, uvx, or image config" }),
          ...(canExportServersJson(formatGateValues)
            ? {}
            : { servers: "Docker image servers can't be expressed" }),
        }
      : {};
  // The gates apply to CONVERSION TARGETS. A paste's own detected format is
  // never disabled: the text on screen is the user's paste, not our
  // serialization, so the select must not show its current value as
  // impossible (e.g. a servers-wrapped docker-run config Archestra
  // normalizes to an image entry it could not itself re-export as servers).
  if (!untouched && detectedFormat) {
    delete formatDisabledReasons[detectedFormat];
  }

  const canApply =
    !untouched && plan?.applied === true && !selectedIsLocalButDisabled;

  const ctaLabel =
    servers.length > 1 ? "Apply selected server" : "Apply changes";

  // Copies/downloads the editor text verbatim — what you see is what you get
  // (secret values are already masked at serialization time).
  const handleCopy = async () => {
    try {
      await copyToClipboard(text);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access denied — the icon simply doesn't flip to a check.
    }
  };
  const downloadFileName = mcpJsonExportFileName(
    effectiveFormat,
    selectedServer?.key || connectionServerKey(form.getValues()),
  );
  const handleDownload = () => {
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadFileName;
    anchor.click();
    // Deferred: revoking synchronously can orphan the blob URL before the
    // browser has started fetching it for the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  // What the exported JSON can NOT express, stated affirmatively while the
  // panel is a mirror — this block is the single JSON surface.
  const currentAuthMethod = currentValues.authMethod;
  const formOnlyAuthLabel =
    currentAuthMethod === "oauth"
      ? "OAuth"
      : currentAuthMethod === "oauth_client_credentials"
        ? "OAuth (client credentials)"
        : currentAuthMethod === "enterprise_managed"
          ? "IdP token exchange"
          : currentAuthMethod === "idp_jwt"
            ? "IdP signed JWT"
            : null;
  // The self-hosted `mcpServers` entry shape has no headers — header auth
  // and custom headers configured on a local server are absent from this
  // JSON and must be called out affirmatively.
  const localHeadersNotInJson =
    currentValues.serverType === "local" &&
    (currentAuthMethod === "auth_header" ||
      currentAuthMethod === "bearer" ||
      (currentValues.additionalHeaders?.length ?? 0) > 0);
  const envFromCount = currentValues.localConfig?.envFrom?.length ?? 0;
  const mountedFileCount = (
    currentValues.localConfig?.environment ?? []
  ).filter((env) => env.mounted).length;
  // Whether the config carries secret-ish material. Derived from the FORM,
  // not the serialized text: the registry format writes no placeholder
  // literals, so a text scan would toggle the footnote — and jump the
  // layout — on a format switch.
  const formHasSecrets =
    currentValues.authMethod === "bearer" ||
    (currentValues.additionalHeaders ?? []).some(
      (header) => header.promptOnInstallation,
    ) ||
    (currentValues.localConfig?.environment ?? []).some(
      (env) =>
        !env.mounted && (env.type === "secret" || env.promptOnInstallation),
    );
  // Only errors on fields that actually serialize into this JSON — the
  // transport/port/path deployment fields no longer do.
  const localErrors = formErrors.localConfig;
  const hasConnectionErrors = Boolean(
    formErrors.serverUrl ||
      localErrors?.command ||
      localErrors?.arguments ||
      localErrors?.dockerImage ||
      localErrors?.environment ||
      (currentValues.serverType === "remote" &&
        (formErrors.authHeaderName || formErrors.additionalHeaders)),
  );

  const handleApply = () => {
    if (!selectedServer || !plan?.applied || !canApply) return;
    // Deep clone: RHF's getValues() returns a top-level spread, so nested
    // objects (localConfig) alias the live form and would be mutated by the
    // apply — leaving Undo nothing to restore.
    const snapshot = structuredClone(form.getValues());
    const outcome = applyImportedServerToForm({
      form,
      server: selectedServer,
      allowServerTypeChange: mode === "create",
      transportConfigured,
    });
    if (!outcome.applied) {
      toast.error(outcome.reason);
      return;
    }
    // Resume mirroring the (now updated) form.
    seedFromForm(exportFormat);
    const typeLabel =
      selectedServer.values.serverType === "local" ? "Self-hosted" : "Remote";
    const fieldCount = plan.changes.length;
    const multiClause =
      servers.length > 1
        ? ` · 1 of ${servers.length} servers in the paste`
        : "";
    toast.success(
      `Applied "${selectedServer.key || "server"}" — ${typeLabel} · ${fieldCount} field${fieldCount === 1 ? "" : "s"} changed${multiClause}`,
      {
        action: {
          label: "Undo",
          onClick: () =>
            revertApplyChanges({
              form,
              snapshot,
              touchedPaths: plan.touchedPaths,
            }),
        },
      },
    );
  };
  const handleApplyRef = useRef(handleApply);
  handleApplyRef.current = handleApply;

  // Draft-state report for the form's submit guard. Effect (not render-phase):
  // it sets the PARENT's state.
  const hasPendingDraft = !untouched;
  useEffect(() => {
    onDraftStateChange?.(hasPendingDraft);
  }, [hasPendingDraft, onDraftStateChange]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  // Everything the controller closes over is stable (state setters, refs) —
  // the assignment only needs to follow the ref prop itself.
  useEffect(() => {
    if (!controllerRef) return;
    const bringIntoView = () => {
      // Next frame: an expand triggered in the same call must commit before
      // the revealed content can be scrolled to. jsdom has no scrollIntoView —
      // optional call.
      requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView?.({
          behavior: "smooth",
          block: "center",
        });
        // Focus parks on the panel itself so an intercepted paste is never
        // one Enter away from submitting the form from the field it landed
        // in.
        rootRef.current?.focus({ preventScroll: true });
      });
    };
    controllerRef.current = {
      reviewPaste: (pastedText: string) => {
        setCollapsed(false);
        setText(pastedText);
        setSelectedIndex(null);
        bringIntoView();
      },
      reveal: () => {
        setCollapsed(false);
        bringIntoView();
      },
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef]);

  return (
    // tabIndex -1: programmatic focus target only (see bringIntoView).
    <div
      ref={rootRef}
      tabIndex={-1}
      className="outline-none"
      data-testid="connection-json-panel"
    >
      <Collapsible
        open={!collapsed}
        onOpenChange={(open) => setCollapsed(!open)}
        className="rounded-lg border"
      >
        {/* The whole bar is the trigger — the same collapsible-section
            anatomy as Sharing & placement and Advanced on this form:
            full-width row, rotating chevron, hover on the entire bar. The
            editor's own chrome (format select, download, copy) is a
            separate bar inside the content, collapsing with the editor. */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-muted/40"
          >
            <span className="flex items-center gap-2">
              <ChevronRight
                className={`h-4 w-4 text-muted-foreground transition-transform ${
                  collapsed ? "" : "rotate-90"
                }`}
              />
              <FileJson className="h-4 w-4 text-muted-foreground" />
              {/* Function-named like the page's other section bars (Sharing
                  & placement, Advanced) — what the block does, not what it
                  is. */}
              <span>Import &amp; export</span>
            </span>
            {/* Right slot, house-summary style: a pending draft outranks the
                standing paste invitation. */}
            {collapsed && hasPendingDraft ? (
              <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-normal text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-100">
                Unapplied edits
              </span>
            ) : (
              <span className="truncate font-normal text-muted-foreground">
                Paste a config from a README or another MCP client to import it
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        {/* forceMount keeps Monaco loaded across collapse (no reload flash
            on expand, draft text preserved) — but it also makes Radix treat
            the content as permanently open, so hiding is ours: the explicit
            `hidden` attribute (spread after Radix's own props, so it wins).
            The editor wrapper's automaticLayout re-measures on reveal. */}
        <CollapsibleContent forceMount hidden={collapsed}>
          {/* Editor chrome bar: format select (mirror) / detected-format
              badge (draft) on the left, download+copy on the right. */}
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-t border-b bg-muted/30 pr-1.5 pl-1.5">
            <div className="flex min-w-0 items-center gap-1">
              {untouched ||
              (detectedFormat !== null && servers.length === 1) ? (
                // One control for both states: it shows the mirrored view's
                // format, or auto-selects the format a paste was recognized
                // as; picking another entry converts the pasted config.
                <McpJsonFormatSelect
                  value={effectiveFormat}
                  onValueChange={handleFormatChange}
                  disabledReasons={formatDisabledReasons}
                />
              ) : parseResult.status === "servers" ? (
                <Badge variant="secondary">{parseResult.formatLabel}</Badge>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Accepts <code>mcpServers</code>, <code>servers</code>, a
                  registry <code>server.json</code>, or a bare entry
                </span>
              )}
            </div>
            {/* No tooltips: download and copy icons are a universal
                pattern, and the interactions carry their own feedback
                (check + toast; the browser's download UI). aria-labels
                keep them named for assistive tech. */}
            {text.trim() !== "" && (
              <div className="flex gap-0.5">
                <button
                  type="button"
                  aria-label="Download JSON"
                  className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={handleDownload}
                >
                  <Download className="size-3.5" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  aria-label={copied ? "Copied!" : "Copy JSON"}
                  className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check
                      className="size-3.5 text-green-500"
                      strokeWidth={2.5}
                    />
                  ) : (
                    <Copy className="size-3.5" strokeWidth={2} />
                  )}
                </button>
              </div>
            )}
          </div>
          <div className="relative h-72">
            <Editor
              height="100%"
              defaultLanguage="json"
              value={text}
              onChange={(value) => {
                setText(value ?? "");
                setSelectedIndex(null);
              }}
              onMount={(editor, monaco) => {
                // addAction (not addCommand): scoped to this editor instance
                // and disposed with it — addCommand registers a page-global
                // keybinding that would outlive the panel.
                editor.addAction({
                  id: "apply-imported-config",
                  label: "Apply imported config",
                  keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
                  run: () => handleApplyRef.current(),
                });
              }}
              loading={
                <div className="flex h-full w-full items-center justify-center bg-muted/50">
                  <p className="text-sm text-muted-foreground">
                    Loading editor...
                  </p>
                </div>
              }
              options={{
                minimap: { enabled: false },
                lineNumbers: "on",
                folding: true,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                fontSize: 13,
                fontFamily: "monospace",
                tabSize: 2,
                padding: { top: 8, bottom: 8 },
                // No current-line highlight: on an empty editor it renders as
                // a stray bar under the ghost placeholder.
                renderLineHighlight: "none",
                overviewRulerBorder: false,
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                scrollbar: {
                  vertical: "auto",
                  horizontal: "auto",
                  verticalScrollbarSize: 10,
                },
              }}
            />
            {text.trim() === "" && (
              <pre className="pointer-events-none absolute inset-0 z-10 select-none overflow-hidden py-2 pl-16 font-mono text-[13px] leading-[19px] text-muted-foreground/50">
                {EDITOR_PLACEHOLDER}
              </pre>
            )}
          </div>

          {/* Everything below the editor is part of the same block — house
            collapsible content spacing (border-t px-4 py-4). */}
          <div className="space-y-3 border-t px-4 py-4">
            {lockedType !== null && !untouched && (
              <Alert>
                <Lock className="h-4 w-4" />
                <AlertDescription>
                  <span>
                    Server type is fixed after creation — this server is{" "}
                    {lockedType === "remote" ? "Remote" : "Self-hosted"}, so
                    only{" "}
                    {lockedType === "remote"
                      ? "URL-shaped"
                      : "command or image-shaped"}{" "}
                    configs can be applied.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {!untouched && parseResult.status === "invalid-json" && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <span>Not valid JSON: {parseResult.error}.</span>
                </AlertDescription>
              </Alert>
            )}

            {!untouched && parseResult.status === "unrecognized" && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="block leading-6">
                  This JSON parses, but no MCP server definition was recognized
                  in it. Expected a <code>mcpServers</code> or{" "}
                  <code>servers</code> wrapper, a registry{" "}
                  <code>server.json</code>, or an object with a{" "}
                  <code>command</code> or <code>url</code>.
                </AlertDescription>
              </Alert>
            )}

            {!untouched && parseResult.status === "args-array" && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <span>
                    This is a bare arguments array — paste it directly into the
                    Arguments field, or paste a full server config here.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {untouched ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    <span>
                      Follows the form fields as you edit — change the JSON or
                      paste a different config to see what applying it would
                      change.
                    </span>
                    {mode === "edit" && formIsDirty && (
                      <span> Includes unsaved changes.</span>
                    )}
                  </p>
                  {formHasSecrets && (
                    <p className="text-xs text-muted-foreground">
                      {exportFormat === "registry" ? (
                        <span>
                          Secret values are never written into{" "}
                          <code>server.json</code> — rows are declared{" "}
                          <code>isSecret</code> and {appName} requests them at
                          install.
                        </span>
                      ) : (
                        <span>
                          Secret values are masked as{" "}
                          <code>&lt;secret&gt;</code> — wherever you paste this,
                          provide real values ({appName} prompts on install).
                        </span>
                      )}
                    </p>
                  )}
                </div>

                {hasConnectionErrors && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      The form has validation errors — fix them before using
                      this config elsewhere.
                    </span>
                  </div>
                )}

                {formOnlyAuthLabel && (
                  <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {formOnlyAuthLabel} is configured for this server — it is
                      managed in the Authentication section, not in this JSON.
                      Client config formats have no way to express it.
                    </span>
                  </div>
                )}

                {localHeadersNotInJson && (
                  <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Header authentication and custom headers are configured in
                      the form — the self-hosted config shape has no headers, so
                      they are not part of this JSON.
                    </span>
                  </div>
                )}

                {currentValues.serverType === "local" &&
                  currentValues.localConfig?.transportType ===
                    "streamable-http" && (
                    <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                      <Layers className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        Streamable HTTP is how {appName} exposes this deployment
                        on the MCP gateway — the transport, port, and path are
                        deployment settings configured in the form. The exported
                        JSON never carries them (a registry package just
                        declares plain stdio).
                      </span>
                    </div>
                  )}

                {currentValues.serverType === "local" &&
                  Boolean(currentValues.localConfig?.dockerImage) && (
                    <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                      <Layers className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        The Docker image runs as a Kubernetes deployment in{" "}
                        {appName} — most MCP clients can't run an image-based
                        server from a config file.
                      </span>
                    </div>
                  )}

                {envFromCount > 0 && (
                  <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    <Layers className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {envFromCount === 1 ? (
                        <span>1 env source (envFrom) is</span>
                      ) : (
                        <span>{envFromCount} env sources (envFrom) are</span>
                      )}{" "}
                      configured under Advanced — env sources are not part of
                      this JSON.
                    </span>
                  </div>
                )}

                {mountedFileCount > 0 && (
                  <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    <Layers className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {mountedFileCount === 1 ? (
                        <span>1 secret file is</span>
                      ) : (
                        <span>{mountedFileCount} secret files are</span>
                      )}{" "}
                      configured under Advanced — mounted files are not part of
                      this JSON.
                    </span>
                  </div>
                )}
              </div>
            ) : (
              parseResult.status === "servers" &&
              servers.length > 1 && (
                <p className="text-sm text-muted-foreground">
                  {servers.length} servers found — this entry holds one server;
                  pick which to apply.
                </p>
              )
            )}

            {servers.length > 1 && (
              <RadioGroup
                value={effectiveIndex === null ? "" : String(effectiveIndex)}
                onValueChange={(value) => setSelectedIndex(Number(value))}
                className="space-y-1"
              >
                {servers.map((server, index) => {
                  const compatible = isCompatible(server);
                  return (
                    <div
                      key={server.key || String(index)}
                      className="flex items-center gap-2"
                    >
                      <RadioGroupItem
                        value={String(index)}
                        id={`json-panel-server-${index}`}
                        disabled={!compatible}
                      />
                      <Label
                        htmlFor={`json-panel-server-${index}`}
                        className={`flex items-center gap-2 font-normal ${
                          compatible
                            ? "cursor-pointer"
                            : "cursor-not-allowed opacity-60"
                        }`}
                      >
                        <span className="font-mono">
                          {server.key || "(unnamed)"}
                        </span>
                        <ServerTypeBadge
                          serverType={server.values.serverType}
                        />
                        {!compatible && (
                          <span className="text-xs text-muted-foreground">
                            this server is{" "}
                            {lockedType === "remote" ? "Remote" : "Self-hosted"}
                          </span>
                        )}
                      </Label>
                    </div>
                  );
                })}
              </RadioGroup>
            )}

            {parseResult.status === "servers" &&
              lockedType !== null &&
              compatibleCount === 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <span>
                      None of the pasted servers are{" "}
                      {lockedType === "remote" ? "Remote" : "Self-hosted"} —
                      paste a matching config, or create a new server.
                    </span>
                  </AlertDescription>
                </Alert>
              )}

            {!untouched && selectedServer && selectedIsCompatible && (
              <ImportPreview server={selectedServer} />
            )}

            {!untouched &&
              selectedServer &&
              selectedIsCompatible &&
              selectedServer.warnings.length > 0 && (
                <Alert
                  variant="default"
                  className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20"
                >
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <AlertDescription className="text-amber-800 dark:text-amber-200">
                    <ul className="list-inside list-disc space-y-1">
                      {selectedServer.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

            {selectedIsLocalButDisabled && (
              <Alert
                variant="default"
                className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20"
              >
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-800 dark:text-amber-200">
                  This is a self-hosted server, but the Kubernetes runtime is
                  not available: {LOCAL_MCP_DISABLED_MESSAGE}
                </AlertDescription>
              </Alert>
            )}

            {!untouched && plan?.applied && (
              <div className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-sm">
                <p className="font-medium">Changes</p>
                {plan.changes.length === 0 ? (
                  <p className="text-muted-foreground">
                    Nothing changes — the form already matches this config.
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {plan.changes.map((change) => (
                      <li key={change.label} className="text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {change.label}
                        </span>{" "}
                        — {change.detail}
                      </li>
                    ))}
                  </ul>
                )}
                {plan.gating.map((line) => (
                  <p key={line} className="text-muted-foreground">
                    {line}
                  </p>
                ))}
                {plan.kept && (
                  <p className="text-xs text-muted-foreground">{plan.kept}</p>
                )}
              </div>
            )}

            {!untouched && (
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => seedFromForm(exportFormat)}
                >
                  <span>Discard</span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!canApply}
                  onClick={handleApply}
                >
                  <span>{ctaLabel}</span>
                </Button>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function ServerTypeBadge({
  serverType,
}: {
  serverType: McpCatalogFormValues["serverType"];
}) {
  return serverType === "remote" ? (
    <Badge variant="outline" className="gap-1">
      <Globe className="h-3 w-3" />
      <span>Remote</span>
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1">
      <Server className="h-3 w-3" />
      <span>Self-hosted</span>
    </Badge>
  );
}

// Compact summary of what the pasted config maps to.
function ImportPreview({ server }: { server: ImportedMcpServer }) {
  const { values } = server;
  const environment = values.localConfig?.environment ?? [];
  const headers = values.additionalHeaders ?? [];
  const argumentCount = (values.localConfig?.arguments ?? "")
    .split("\n")
    .filter((argument) => argument.trim().length > 0).length;

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
      <PreviewRow label="Type">
        <ServerTypeBadge serverType={values.serverType} />
      </PreviewRow>
      {values.serverType === "remote" ? (
        <PreviewRow label="URL">
          <span className="break-all font-mono">{values.serverUrl}</span>
        </PreviewRow>
      ) : (
        <>
          {values.localConfig?.command ? (
            <PreviewRow label="Command">
              <span className="break-all font-mono">
                {values.localConfig.command}
                {argumentCount > 0 && (
                  <span className="text-muted-foreground">
                    {" "}
                    (+{argumentCount} argument
                    {argumentCount === 1 ? null : <span>s</span>})
                  </span>
                )}
              </span>
            </PreviewRow>
          ) : (
            argumentCount > 0 && (
              <PreviewRow label="Arguments">
                <span>
                  {argumentCount} argument
                  {argumentCount === 1 ? null : <span>s</span>}
                </span>
              </PreviewRow>
            )
          )}
          {values.localConfig?.dockerImage && (
            <PreviewRow label="Image">
              <span className="break-all font-mono">
                {values.localConfig.dockerImage}
              </span>
            </PreviewRow>
          )}
        </>
      )}
      {values.authMethod === "auth_header" && (
        <PreviewRow label="Auth">
          <span>Token header, requested when connecting</span>
        </PreviewRow>
      )}
      {headers.length > 0 && (
        <PreviewRow label="Headers">
          <span className="flex flex-wrap gap-1">
            {headers.map((header) => (
              <Badge
                key={header.headerName}
                variant="outline"
                className="font-mono font-normal"
              >
                {header.headerName}
                {header.promptOnInstallation && (
                  <span className="ml-1 text-muted-foreground">· prompted</span>
                )}
              </Badge>
            ))}
          </span>
        </PreviewRow>
      )}
      {environment.length > 0 && (
        <PreviewRow label="Env vars">
          <span className="flex flex-wrap gap-1">
            {environment.map((env) => (
              <Badge
                key={env.key}
                variant="outline"
                className="font-mono font-normal"
              >
                {env.key}
                {env.type === "secret" && (
                  <span className="ml-1 text-muted-foreground">· secret</span>
                )}
                {env.promptOnInstallation && (
                  <span className="ml-1 text-muted-foreground">· prompted</span>
                )}
              </Badge>
            ))}
          </span>
        </PreviewRow>
      )}
    </div>
  );
}

function PreviewRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
