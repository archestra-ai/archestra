"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  BUILT_IN_AGENT_IDS,
  DocsPage,
  getDocsUrl,
  parseFullToolName,
} from "@archestra/shared";
import type { EditorProps } from "@monaco-editor/react";
import { useQueries } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronDown,
  KeyRound,
  PackageSearch,
  Settings2,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
  MISSING_CREDENTIAL_BEHAVIOR_OPTIONS,
  MISSING_CREDENTIAL_TONE,
  shouldOfferAppCatalogs,
} from "@/components/agent-form.utils";
import { AgentIcon } from "@/components/agent-icon";
import { filterExcludableTools } from "@/components/agent-tool-exclusions-editor.utils";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { CopyButton } from "@/components/copy-button";
import { Editor } from "@/components/editor";
import { EntityPill as Pill } from "@/components/entity-pill";
import { KnowledgeSourceIcon } from "@/components/knowledge-source-icon";
import { LabelTags } from "@/components/label-tags";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SettingGroup, SettingRow } from "@/components/setting-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDelegationTargetAgents } from "@/lib/agent.query";
import {
  useAgentSkillExclusions,
  useAgentSkills,
} from "@/lib/agent-skills.query";
import { useAgentSubagentExclusions } from "@/lib/agent-subagent-exclusions.query";
import { useAgentToolExclusions } from "@/lib/agent-tool-exclusions.query";
import { useAgentDelegations } from "@/lib/agent-tools.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { useFeature } from "@/lib/config/config.query";
import { FIELD_LABEL, formatCreated } from "@/lib/design/resource-lexicon";
import { typeRole } from "@/lib/design/type-scale";
import { useEnvironments } from "@/lib/environment.query";
import { useOrganizationDefaultModel } from "@/lib/hooks/use-organization-default-model";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useConnectors } from "@/lib/knowledge/connector.query";
import {
  useIsKnowledgeBaseConfigured,
  useKnowledgeBases,
} from "@/lib/knowledge/knowledge-base.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import {
  type CatalogTool,
  fetchCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { providerToLogoProvider } from "@/lib/provider-logos";
import { cn, formatDate } from "@/lib/utils";
import {
  AGENT_PAGE_CONFIGS,
  type AgentPageKind,
  agentDetailHref,
} from "./agent-page-config";

type Agent = archestraApiTypes.GetAgentResponses["200"];

/** How many named items (tools, subagents, skills) a section lists before summarising. */
const PREVIEW_LIMIT = 12;

/**
 * The Overview tab of an agent's detail page: one card per subject, stacked
 * the wizard's column wide, as the wizard itself is. Each card that mirrors
 * one of the setup wizard's steps repeats it read-only, in the wizard's order
 * and with the wizard's own visuals (server pills with icons and counts,
 * agent and skill chips), as values rather than prose — the page's one Edit
 * lives in the header. The record's provenance — id, dates, owner — closes
 * the page in a card the wizard never wrote and so cannot edit.
 */
export function AgentOverview({
  kind,
  agent,
}: {
  kind: AgentPageKind;
  agent: Agent;
}) {
  const isBuiltIn = !!agent.builtIn;
  const showsTools = kind !== "llm_proxy" && !isBuiltIn;
  const showsInstruction = kind === "agent";
  // Delegation is keyed on the stored type, not the route family: gateways and
  // legacy profiles have subagents too, only true LLM proxies do not.
  const showsSubagents = agent.agentType !== "llm_proxy" && !isBuiltIn;
  const showsAdvanced = !isBuiltIn;

  return (
    <div className="space-y-4">
      <SummarySection kind={kind} agent={agent} />
      {showsInstruction && <InstructionSection agent={agent} />}
      {showsInstruction && agent.suggestedPrompts.length > 0 && (
        <SuggestedPromptsSection agent={agent} />
      )}
      {showsTools && <ToolsSection kind={kind} agent={agent} />}
      {showsSubagents && <SubagentsSection agent={agent} />}
      {showsTools && <SkillsSection agent={agent} />}
      {/* Last of the wizard's steps, as on the wizard itself. */}
      {showsAdvanced && <AdvancedSection kind={kind} agent={agent} />}
      <DetailsSection agent={agent} />
    </div>
  );
}

/**
 * What the agent answers with and where it runs — the wizard's first step,
 * minus the parts big enough to be their own card (the instruction, the
 * prompts). Who owns the record is not here: the page title carries its
 * visibility badge, and the closing Details card names the owner.
 */
function SummarySection({
  kind,
  agent,
}: {
  kind: AgentPageKind;
  agent: Agent;
}) {
  const isBuiltIn = !!agent.builtIn;
  const { data: environmentsData } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();

  const environmentName = agent.environmentId
    ? (environmentsData?.environments.find((e) => e.id === agent.environmentId)
        ?.name ?? null)
    : defaultEnvironment.name;
  // The model is a chat agent's business — built-in ones included, as on the
  // form; proxies and gateways answer with whatever the caller sends.
  const showsModel = kind === "agent";
  const showsEnvironment = kind !== "agent" || !isBuiltIn;

  return (
    <OverviewSection
      // Named after what the card actually holds: a built-in agent shows a
      // model and no environment, and a proxy or gateway shows an environment
      // and no model, so a fixed pair of nouns names a field that is not there.
      // "Where it runs" for those two, because a title that repeats the one
      // label under it says nothing the label did not.
      title={
        showsModel && showsEnvironment
          ? "Model and environment"
          : showsModel
            ? "Model"
            : "Where it runs"
      }
    >
      <FieldGrid>
        {showsModel && <ModelField agent={agent} />}
        {showsEnvironment && (
          <OverviewField label="Environment">
            {environmentName ? (
              <span>{environmentName}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </OverviewField>
        )}
      </FieldGrid>
    </OverviewSection>
  );
}

/**
 * The record itself: the id an API call needs, when it was made and last
 * changed, and who it belongs to. Nothing here was written on a wizard step,
 * so the card offers no way into one. Only dates are shown for the last
 * change: the agent row records when, never by whom.
 */
function DetailsSection({ agent }: { agent: Agent }) {
  const teams = agent.teams ?? [];
  const users = agent.users ?? [];
  const { data: session } = useSession();
  // A per-user share is stored as `personal` plus grants, so neither the page
  // title's scope badge nor the Owner field below can carry it: an agent
  // shared with three named people read as purely private everywhere on the
  // page. Named only when there is something the scope badge does not already
  // say — "Shared with: Me" on a page only its owner can open is a tautology.
  const isSharedBeyondScope =
    users.length > 0 || (agent.scope !== "team" && teams.length > 0);

  return (
    <OverviewSection title="Details">
      <FieldGrid>
        <OverviewField label="ID">
          <IdWithCopy id={agent.id} />
        </OverviewField>
        <OverviewField label={FIELD_LABEL.created}>
          <span>{formatCreated({ createdAt: agent.createdAt })}</span>
        </OverviewField>
        <OverviewField label={FIELD_LABEL.lastUpdated}>
          <span>{formatDate({ date: agent.updatedAt, dateFormat: "PP" })}</span>
        </OverviewField>
        {agent.labels.length > 0 && (
          <OverviewField label="Labels">
            <LabelTags labels={agent.labels} />
          </OverviewField>
        )}
        {agent.scope === "team" && teams.length > 0 ? (
          <OverviewField label="Teams">
            <ul className="flex flex-wrap gap-1.5">
              {teams.map((team) => (
                <li key={team.id}>
                  <Pill name={team.name} />
                </li>
              ))}
            </ul>
          </OverviewField>
        ) : agent.authorName ? (
          <OverviewField label="Owner">
            <span>{agent.authorName}</span>
          </OverviewField>
        ) : null}
        {isSharedBeyondScope && (
          <OverviewField label="Shared with">
            <ResourceVisibilityBadge
              scope={agent.scope}
              teams={teams}
              users={users}
              authorId={agent.authorId}
              authorName={agent.authorName}
              currentUserId={session?.user?.id}
              showSelfAsMe={false}
            />
          </OverviewField>
        )}
      </FieldGrid>
    </OverviewSection>
  );
}

/**
 * The provider key and model, as the form's two pickers show them: the model
 * with its provider's logo, and under it the key — "Organization default"
 * when none is picked. An agent without a model of its own names the model
 * the organization default currently points at.
 */
function ModelField({ agent }: { agent: Agent }) {
  const providerCatalog = useModelProviderCatalog();
  const hasOwnModel = !!(agent.resolvedLlmModelName || agent.modelId);
  const { data: canReadKeys } = useHasPermissions({
    llmProviderApiKey: ["read"],
  });
  const { data: keys } = useAvailableLlmProviderApiKeys({
    includeKeyId: agent.llmApiKeyId ?? undefined,
    enabled: !!agent.llmApiKeyId && !!canReadKeys,
  });
  const key = agent.llmApiKeyId
    ? keys?.find((candidate) => candidate.id === agent.llmApiKeyId)
    : undefined;
  const organizationDefault = useOrganizationDefaultModel({
    enabled: !hasOwnModel,
  });

  const provider = hasOwnModel
    ? (agent.resolvedLlmProvider ?? null)
    : (organizationDefault.model?.provider ?? null);
  const modelName = hasOwnModel
    ? [
        agent.resolvedLlmProvider
          ? providerCatalog.label(agent.resolvedLlmProvider)
          : null,
        agent.resolvedLlmModelName ?? agent.modelId,
      ]
        .filter(Boolean)
        .join(" · ")
    : organizationDefault.label;

  return (
    <OverviewField label="Model">
      <div className="space-y-1">
        {modelName ? (
          <span className="flex items-start gap-1.5 font-medium">
            {provider && (
              <ModelSelectorLogo
                provider={providerToLogoProvider[provider]}
                className="mt-0.5 size-3.5 shrink-0"
              />
            )}
            <span>{modelName}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Best available model</span>
        )}
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <KeyRound className="size-3 shrink-0" />
          <span>
            {agent.llmApiKeyId
              ? (key?.name ?? "Provider key")
              : "Organization default"}
          </span>
        </span>
      </div>
    </OverviewField>
  );
}

function InstructionSection({ agent }: { agent: Agent }) {
  const prompt = agent.systemPrompt?.trim() ?? "";
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  // The prompt reads in the same editor the wizard writes it in, read-only,
  // so its Handlebars keeps its highlighting. The editor is given its whole
  // content height (never its own scrollbar) and the box around it does the
  // clipping: a long prompt would push everything below it off the page, so
  // it opens clipped behind a fade, with the toggle laid over the text. The
  // height is what the editor reports once mounted — it re-wraps with the
  // column — seeded from the line count until then.
  const [contentHeight, setContentHeight] = useState(() =>
    estimatePromptHeight(prompt),
  );
  const isLong = contentHeight > COLLAPSED_PROMPT_HEIGHT_PX;

  return (
    <OverviewSection title="Instruction">
      {prompt ? (
        // `group`: the toggle brightens when the pointer is anywhere over the
        // instruction, not only over the toggle itself.
        <div className="group relative">
          {/* The clip animates between its collapsed height and the prompt's
              full height. Its lower edge fades out through a mask — the
              editor paints its own theme background, which no overlay colour
              would match in every theme — and in the open state that faded
              strip is only the room kept under the last line for the toggle. */}
          <div
            id={contentId}
            className={cn(
              "overflow-hidden rounded-md border",
              isLong &&
                "motion-safe:transition-[max-height] motion-safe:duration-300 motion-safe:ease-in-out",
              // Only the clipped state fades, and only over the strip the
              // toggle sits in: masking further up dissolved text that is
              // fully visible, and masking the open state greyed an empty
              // gutter.
              isLong &&
                !expanded &&
                "[mask-image:linear-gradient(to_bottom,black_calc(100%-2.25rem),transparent)]",
            )}
            style={
              isLong
                ? {
                    maxHeight: expanded
                      ? contentHeight + PROMPT_TOGGLE_STRIP_PX
                      : COLLAPSED_PROMPT_HEIGHT_PX,
                  }
                : undefined
            }
          >
            {/* A strip along the bottom for the toggle, so it never covers
                the prompt's last line. */}
            <div className={cn(isLong && "pb-9")}>
              <Editor
                height={contentHeight}
                defaultLanguage="handlebars"
                value={prompt}
                onMount={(editor) => {
                  const measure = () =>
                    setContentHeight(editor.getContentHeight());
                  measure();
                  editor.onDidContentSizeChange(measure);
                }}
                options={READ_ONLY_PROMPT_EDITOR_OPTIONS}
              />
            </div>
          </div>
          {isLong && (
            /* A glass disc centred on the lower edge: faint until the pointer
               is over the instruction, pressed and focused like any other
               button, its chevron turning with the clip. */
            <Button
              type="button"
              variant="outline-transparent"
              size="icon-sm"
              aria-expanded={expanded}
              aria-controls={contentId}
              aria-label={expanded ? "Show less" : "Show full instruction"}
              title={expanded ? "Show less" : "Show full instruction"}
              onClick={() => setExpanded((current) => !current)}
              className="absolute bottom-1 left-1/2 size-7 -translate-x-1/2 rounded-full bg-background/50 text-muted-foreground opacity-60 shadow-sm backdrop-blur-sm group-hover:bg-background group-hover:text-foreground group-hover:opacity-100 group-hover:shadow-md hover:bg-background hover:text-foreground hover:opacity-100 hover:shadow-md focus-visible:opacity-100 active:scale-95 active:shadow-none"
            >
              <ChevronDown
                className={cn(
                  "size-4 motion-safe:transition-transform motion-safe:duration-300",
                  expanded && "rotate-180",
                )}
              />
            </Button>
          )}
        </div>
      ) : (
        <p className={typeRole({ role: "body" })}>
          None — platform defaults apply.
        </p>
      )}
    </OverviewSection>
  );
}

function SuggestedPromptsSection({ agent }: { agent: Agent }) {
  return (
    <OverviewSection title="Suggested prompts">
      <ul className="space-y-2">
        {agent.suggestedPrompts.map((prompt, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: summary titles are not unique, and this list is read-only and never reordered
            key={`${index}:${prompt.summaryTitle}`}
            className="rounded-md border px-3 py-2"
          >
            <div className={cn(typeRole({ role: "body" }), "font-medium")}>
              {prompt.summaryTitle}
            </div>
            <div className={typeRole({ role: "body" })}>{prompt.prompt}</div>
          </li>
        ))}
      </ul>
    </OverviewSection>
  );
}

/**
 * The wizard's Advanced step, named for what is inside it: how much the
 * context is trusted, who vouches for the caller, and what travels through to
 * the servers behind it. "Advanced" told a reader of a read-only page nothing
 * at all about what the card holds.
 */
function AdvancedSection({
  kind,
  agent,
}: {
  kind: AgentPageKind;
  agent: Agent;
}) {
  const { data: canReadIdentityProviders } = useHasPermissions({
    identityProvider: ["read"],
  });
  const { data: identityProviders } = useIdentityProviders({
    enabled: !!agent.identityProviderId && !!canReadIdentityProviders,
  });
  const identityProvider = identityProviders?.find(
    (idp) => idp.id === agent.identityProviderId,
  );
  const showsSecurity = kind === "agent" || kind === "llm_proxy";

  return (
    <OverviewSection title="Security and identity">
      <FieldGrid>
        {showsSecurity && (
          <OverviewField label="Security">
            <span>
              {agent.considerContextUntrusted
                ? "Sensitive from the start"
                : "Trusted"}
            </span>
          </OverviewField>
        )}
        <OverviewField label="Identity provider">
          {agent.identityProviderId ? (
            identityProvider?.issuer ? (
              <span>{identityProvider.issuer}</span>
            ) : (
              <span className="text-muted-foreground">Configured</span>
            )
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </OverviewField>
        {kind === "mcp_gateway" && (
          <OverviewField label="Passthrough headers">
            {agent.passthroughHeaders && agent.passthroughHeaders.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {agent.passthroughHeaders.map((header) => (
                  <Badge
                    key={header}
                    variant="secondary"
                    className="font-mono font-normal"
                  >
                    {header}
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </OverviewField>
        )}
      </FieldGrid>
    </OverviewSection>
  );
}

function ToolsSection({ kind, agent }: { kind: AgentPageKind; agent: Agent }) {
  const noun = AGENT_PAGE_CONFIGS[kind].singularInSentence;
  const { catalogName: archestraCatalogName } = useArchestraMcpIdentity();
  const { data: exclusions } = useAgentToolExclusions(
    agent.accessAllTools ? agent.id : undefined,
  );
  const { data: canReadKnowledge } = useHasPermissions({
    knowledgeSource: ["read"],
  });
  const hasKnowledge =
    agent.knowledgeBaseIds.length > 0 || agent.connectorIds.length > 0;
  // Auto mode searches the environment rather than an assignment, so the
  // lists are needed there too — see the knowledge block below.
  const showsKnowledge = agent.accessAllTools || hasKnowledge;
  const { data: knowledgeBases } = useKnowledgeBases({
    enabled: !!canReadKnowledge && showsKnowledge,
  });
  const { data: connectors } = useConnectors({
    enabled: !!canReadKnowledge && showsKnowledge,
  });
  const knowledgeConfigured = useIsKnowledgeBaseConfigured();
  // The names and icons behind the tools come from the same catalog the tools
  // editor picks from, so a server reads the same in both places.
  const { data: catalog = [] } = useInternalMcpCatalog({
    includeApps: shouldOfferAppCatalogs(agent.agentType),
  });

  // Auto mode: the disabled tools are ids, and the exclusions editor resolves
  // them to "server N/M disabled" pills through each server's tool list. The
  // same lists (same query keys) give the same pills here.
  const excludedToolIds = exclusions?.excludedToolIds ?? [];
  const toolQueries = useQueries({
    queries: agent.accessAllTools
      ? catalog.map((item) => ({
          queryKey: ["mcp-catalog", item.id, "tools"] as const,
          queryFn: () => fetchCatalogTools(item.id),
        }))
      : [],
  });
  const disabledByServer = useMemo(() => {
    if (!agent.accessAllTools || excludedToolIds.length === 0) return [];
    const excluded = new Set(excludedToolIds);
    const servers: {
      id: string;
      name: string;
      icon: string | null | undefined;
      disabled: number;
      total: number;
    }[] = [];
    let resolved = 0;
    catalog.forEach((item, index) => {
      const tools =
        (toolQueries[index]?.data as CatalogTool[] | undefined) ?? [];
      const excludable = filterExcludableTools(item.id, tools);
      const disabled = excludable.filter((tool) =>
        excluded.has(tool.id),
      ).length;
      resolved += disabled;
      if (disabled > 0) {
        servers.push({
          id: item.id,
          name:
            item.id === ARCHESTRA_MCP_CATALOG_ID
              ? archestraCatalogName
              : item.name,
          icon: item.icon,
          disabled,
          total: excludable.length,
        });
      }
    });
    const unresolved = excludedToolIds.length - resolved;
    const allLoaded = toolQueries.every((query) => query.data !== undefined);
    // Ids no listed server accounts for: a server this viewer cannot read, or
    // one removed since. Only counted once every list has answered, so a
    // still-loading server is not reported as missing.
    if (allLoaded && unresolved > 0) {
      servers.push({
        id: UNKNOWN_CATALOG_ID,
        name: "Other servers",
        icon: null,
        disabled: unresolved,
        total: unresolved,
      });
    }
    return servers;
  }, [
    agent.accessAllTools,
    excludedToolIds,
    catalog,
    toolQueries,
    archestraCatalogName,
  ]);

  const excludedCount = excludedToolIds.length;
  // `agent.tools` carries the delegation rows too (one per subagent). They are
  // the Subagents section's business, and counting them here would inflate the
  // tool count the list pages show for the same record.
  const assignedTools = agent.tools.filter((tool) => !tool.delegateToAgentId);
  const servers = groupToolsByCatalog(assignedTools, catalog).map((server) => ({
    ...server,
    name:
      server.id === ARCHESTRA_MCP_CATALOG_ID
        ? archestraCatalogName
        : server.name,
  }));

  const knowledgeSources = [
    // A knowledge base has no page of its own, so its chip stays inert; a
    // connector's chip opens the connector.
    ...agent.knowledgeBaseIds.map((id) => {
      const base = knowledgeBases?.find((kb) => kb.id === id);
      return base ? { id, name: base.name, connectorType: null } : null;
    }),
    ...agent.connectorIds.map((id) => {
      const connector = connectors?.find((c) => c.id === id);
      return connector
        ? {
            id,
            name: connector.name,
            connectorType: connector.connectorType,
            href: knowledgeConnectorHref(connector.id),
          }
        : null;
    }),
  ].filter((source): source is NonNullable<typeof source> => !!source);
  const knowledgeCount =
    agent.knowledgeBaseIds.length + agent.connectorIds.length;
  // What Auto mode actually searches is resolved per call: every connector in
  // THIS agent's environment that the caller may query — the assignment above
  // is not read at all in that mode. The names here are the ones this reader
  // can see, which is why the block says so rather than claiming a set.
  const environmentSources = (connectors ?? []).filter(
    (connector) =>
      (connector.environmentId ?? null) === (agent.environmentId ?? null),
  );

  const loadsToolsWhenNeeded = agent.toolExposureMode === "search_and_run_only";

  return (
    <OverviewSection
      title="Tools and knowledge sources"
      mode={agent.accessAllTools ? "Auto" : "Custom"}
    >
      {agent.accessAllTools ? (
        <>
          <div className="space-y-1.5">
            <SubHeading label="Disabled tools" />
            {excludedCount === 0 ? (
              <p className={typeRole({ role: "body" })}>None</p>
            ) : disabledByServer.length === 0 ? (
              <p className={typeRole({ role: "body" })}>
                <span>Resolving which servers they belong to…</span>
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {disabledByServer.map((server) => (
                  <li key={server.id}>
                    <Pill
                      icon={
                        <McpCatalogIcon
                          icon={server.icon}
                          catalogId={server.id}
                          size={14}
                        />
                      }
                      name={server.name}
                      note={`${server.disabled}/${server.total} disabled`}
                      href={mcpServerHref(server.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
          {/* Auto always discovers tools on demand (the search/run surface is
              what makes the whole catalog reachable without loading it), so
              the setting reads as the same status indicator it is under
              Custom — a setting, not one more note on the mode. */}
          <KnowledgeBlock
            canRead={!!canReadKnowledge}
            configured={knowledgeConfigured}
            sources={environmentSources.map((connector) => ({
              id: connector.id,
              name: connector.name,
              connectorType: connector.connectorType,
              href: knowledgeConnectorHref(connector.id),
            }))}
            emptyLabel={`No source is set up in this ${noun}'s environment yet.`}
          />
          {/* Both settings, as under Custom — but Auto resolves tools from
              what each caller can already reach, so nothing can be missing
              and the stored choice lies dormant. The row says that rather
              than hiding, which left the setting looking unset. */}
          <SettingGroup>
            <ProgressiveToolLoadingRow kind={kind} on={loadsToolsWhenNeeded} />
            <SettingRow
              icon={<Unplug className="size-4" />}
              title="Tool connections"
              tone="off"
              state="Not needed"
              learnMoreHref={getDocsUrl(
                DocsPage.PlatformAgents,
                "tool-connections",
              )}
            />
          </SettingGroup>
        </>
      ) : (
        <>
          {servers.length === 0 ? (
            <p className={typeRole({ role: "body" })}>No tools assigned yet.</p>
          ) : (
            <ul className="space-y-3">
              {servers.map((server) => (
                <li key={server.id} className="space-y-1.5">
                  <Pill
                    icon={
                      <McpCatalogIcon
                        icon={server.icon}
                        catalogId={server.id}
                        size={14}
                      />
                    }
                    name={server.name}
                    count={server.tools.length}
                    href={mcpServerHref(server.id)}
                  />
                  <div className="flex flex-wrap gap-1.5 pl-1">
                    {server.tools.slice(0, PREVIEW_LIMIT).map((tool) => (
                      <Badge
                        key={tool.id}
                        variant="secondary"
                        className="font-mono font-normal"
                      >
                        {parseFullToolName(tool.name).toolName || tool.name}
                      </Badge>
                    ))}
                    {server.tools.length > PREVIEW_LIMIT && (
                      <Badge variant="outline" className="font-normal">
                        +{server.tools.length - PREVIEW_LIMIT} more
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {/* The assignment is the ceiling here; each caller still reaches
              only the sources they may query. */}
          {hasKnowledge && (
            <KnowledgeBlock
              canRead={!!canReadKnowledge}
              configured={knowledgeConfigured}
              sources={knowledgeSources}
              hiddenCount={knowledgeCount - knowledgeSources.length}
              emptyLabel="None assigned."
            />
          )}
          {/* The form's two Custom-mode settings, as status indicators: both
              only apply to an explicit tool list — an Auto agent always
              discovers tools on demand, and no caller can be missing a
              connection to a server they already reach. */}
          <SettingGroup>
            <ProgressiveToolLoadingRow kind={kind} on={loadsToolsWhenNeeded} />
            <MissingConnectionRow behavior={agent.missingCredentialBehavior} />
          </SettingGroup>
        </>
      )}
    </OverviewSection>
  );
}

function SubagentsSection({ agent }: { agent: Agent }) {
  const { data: delegations = [] } = useAgentDelegations(
    agent.accessAllSubagents ? undefined : agent.id,
  );
  const { data: exclusions } = useAgentSubagentExclusions(
    agent.accessAllSubagents ? agent.id : undefined,
  );
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  // The roster the subagent pickers draw from: it carries each agent's icon,
  // names the disabled ones (the exclusions are ids), and resolves the advisor
  // — which is kept out of both lists and shown as its own switch.
  const { data: roster = [] } = useDelegationTargetAgents({
    enabled: !!canReadAgents,
  });
  const advisorId = roster.find(
    (target) => target.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.ADVISOR,
  )?.id;
  // Which model the advisor answers with is one org-wide setting, so the row
  // points at it rather than repeating it — for readers who may open it.
  const { data: canReadLlmSettings } = useHasPermissions({
    llmSettings: ["read"],
  });
  const excludedIds = exclusions?.excludedSubagentIds ?? [];
  const advisorEnabled = advisorId
    ? agent.accessAllSubagents
      ? !excludedIds.includes(advisorId)
      : delegations.some((target) => target.id === advisorId)
    : false;

  const iconOf = (id: string) =>
    roster.find((target) => target.id === id)?.icon ?? null;
  const targets = delegations.filter((target) => target.id !== advisorId);
  const disabled = excludedIds
    .filter((id) => id !== advisorId)
    .map((id) => ({
      id,
      name: roster.find((target) => target.id === id)?.name ?? null,
    }));
  const namedDisabled = disabled.filter(
    (target): target is { id: string; name: string } => !!target.name,
  );

  return (
    <OverviewSection
      title="Subagents"
      mode={agent.accessAllSubagents ? "Auto" : "Custom"}
    >
      {agent.accessAllSubagents ? (
        <div className="space-y-1.5">
          <SubHeading label="Disabled subagents" />
          {disabled.length === 0 ? (
            <p className={typeRole({ role: "body" })}>None</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {namedDisabled.slice(0, PREVIEW_LIMIT).map((target) => (
                <li key={target.id}>
                  <Pill
                    icon={<AgentIcon icon={iconOf(target.id)} size={14} />}
                    name={target.name}
                    tone="exclude"
                    href={agentDetailHref("agent", target.id)}
                  />
                </li>
              ))}
              {/* The cap applies here as it does to every other list on the
                  page: without this the thirteenth disabled agent onwards
                  simply vanished. */}
              {namedDisabled.length > PREVIEW_LIMIT && (
                <li>
                  <Badge variant="outline" className="font-normal">
                    +{namedDisabled.length - PREVIEW_LIMIT} more
                  </Badge>
                </li>
              )}
              {disabled.length > namedDisabled.length && (
                <li>
                  <Badge variant="outline" className="font-normal">
                    +{disabled.length - namedDisabled.length} not visible to you
                  </Badge>
                </li>
              )}
            </ul>
          )}
        </div>
      ) : targets.length === 0 ? (
        <p className={typeRole({ role: "body" })}>None</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {targets.slice(0, PREVIEW_LIMIT).map((target) => (
            <li key={target.id}>
              <Pill
                icon={<AgentIcon icon={iconOf(target.id)} size={14} />}
                name={target.name}
                href={agentDetailHref("agent", target.id)}
              />
            </li>
          ))}
          {targets.length > PREVIEW_LIMIT && (
            <li>
              <Badge variant="outline" className="font-normal">
                +{targets.length - PREVIEW_LIMIT} more
              </Badge>
            </li>
          )}
        </ul>
      )}
      {/* The wizard's own switch under both modes, as a status tile like
          the tool settings above it — with the Advisor agent's own icon. */}
      {advisorId && (
        <SettingGroup>
          <SettingRow
            icon={
              <AgentIcon
                icon={iconOf(advisorId)}
                fallbackType="agent"
                size={16}
              />
            }
            title="Advisor Subagent"
            badge={<BetaBadge />}
            tone={advisorEnabled ? "on" : "off"}
            state={advisorEnabled ? "On" : "Off"}
            learnMoreHref={getDocsUrl(
              DocsPage.PlatformBuiltInSubagents,
              "advisor",
            )}
            action={canReadLlmSettings ? <AdvisorSettingsLink /> : undefined}
          />
        </SettingGroup>
      )}
    </OverviewSection>
  );
}

function SkillsSection({ agent }: { agent: Agent }) {
  const skillsEnabled = useFeature("mcpGatewaySkillsEnabled") === true;
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const enabled = skillsEnabled && !!canReadSkills;
  const { data: assignments } = useAgentSkills(enabled ? agent.id : undefined);
  const { data: exclusions } = useAgentSkillExclusions(
    enabled ? agent.id : undefined,
  );

  // Nothing to say until the published set has actually loaded: an empty
  // default here would read as "publishes nothing", which is a real setting.
  if (!enabled || !assignments) return null;

  const published = assignments.skills ?? [];
  const excluded = exclusions?.skills ?? [];

  return (
    <OverviewSection
      title="Published skills"
      mode={assignments.accessAllSkills ? "Auto" : "Custom"}
    >
      {assignments.accessAllSkills ? (
        <div className="space-y-1.5">
          <SubHeading label="Excluded skills" />
          {excluded.length === 0 ? (
            <p className={typeRole({ role: "body" })}>None</p>
          ) : (
            <SkillPills skills={excluded} tone="exclude" />
          )}
        </div>
      ) : published.length === 0 ? (
        <p className={typeRole({ role: "body" })}>No skills published yet.</p>
      ) : (
        <SkillPills skills={published} />
      )}
    </OverviewSection>
  );
}

/**
 * One card of the overview: title, optional Auto/Custom mode, and the facts.
 * The page's single Edit lives in the header, so a card carries no chrome of
 * its own.
 *
 * Every title is the same rank. The sections used to split between an h2 for
 * the two that were wizard steps and an h3 for the rest, which put three h3s
 * ahead of the page's first h2 and left that h2 heading nothing subordinate.
 * Cards are siblings, so one rank is the honest one.
 */
function OverviewSection({
  title,
  mode,
  children,
}: {
  title: string;
  mode?: "Auto" | "Custom";
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={typeRole({ role: "section-title" })}>{title}</h2>
        {mode && (
          <Badge variant="secondary" className="font-normal">
            {mode}
          </Badge>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * The labelled facts of a card, two or three to a row. Its own component
 * because three cards lay their fields out the same way and a grid that
 * disagrees between them reads as two different pages.
 */
function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

/** The record's own id, as something to read and something to copy. */
function IdWithCopy({ id }: { id: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className={cn(typeRole({ role: "code" }), "min-w-0 truncate")}>
        {id}
      </code>
      <CopyButton text={id} className="shrink-0" />
    </span>
  );
}

/**
 * The knowledge half of the section, in the tools' own vocabulary: a
 * sub-heading and a wrap of source chips. Auto mode passes the environment's
 * sources, Custom mode the assignment; neither is a promise about another
 * caller.
 */
function KnowledgeBlock({
  canRead,
  configured,
  sources,
  hiddenCount = 0,
  emptyLabel,
}: {
  canRead: boolean;
  configured: boolean;
  sources: {
    id: string;
    name: string;
    connectorType?: string | null;
    /** Connectors have a page of their own; knowledge bases do not. */
    href?: string;
  }[];
  /** Assigned sources this reader cannot see, counted rather than named. */
  hiddenCount?: number;
  emptyLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      <SubHeading label="Knowledge sources" />
      {!configured ? (
        <p className={typeRole({ role: "body" })}>
          Knowledge search is off — no embedding model is configured.
        </p>
      ) : !canRead ? (
        <p className={typeRole({ role: "body" })}>
          You do not have permission to see knowledge sources.
        </p>
      ) : sources.length === 0 && hiddenCount === 0 ? (
        <p className={typeRole({ role: "body" })}>{emptyLabel}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {sources.slice(0, PREVIEW_LIMIT).map((source) => (
            <li key={source.id}>
              <Pill
                icon={
                  <KnowledgeSourceIcon connectorType={source.connectorType} />
                }
                name={source.name}
                href={source.href}
              />
            </li>
          ))}
          {sources.length > PREVIEW_LIMIT && (
            <li>
              <Badge variant="outline" className="font-normal">
                +{sources.length - PREVIEW_LIMIT} more
              </Badge>
            </li>
          )}
          {hiddenCount > 0 && (
            <li>
              <Badge variant="outline" className="font-normal">
                +{hiddenCount} not visible to you
              </Badge>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** The wizard's own sub-label above a group of pills ("Disabled tools"). */
function SubHeading({ label }: { label: string }) {
  return <p className={typeRole({ role: "label" })}>{label}</p>;
}

/** The form's "Load tools progressively when needed" switch, read-only. */
function ProgressiveToolLoadingRow({
  kind,
  on,
}: {
  kind: AgentPageKind;
  on: boolean;
}) {
  return (
    // The row is the setting's subject and the badge its value, as on the
    // rows beside it: "Progressive tool loading: Off" over a line about
    // loading everything upfront read as a contradiction.
    <SettingRow
      icon={<PackageSearch className="size-4" />}
      title="Tools loaded"
      tone={on ? "on" : "off"}
      state={on ? "Progressively" : "Upfront"}
      learnMoreHref={getDocsUrl(
        kind === "mcp_gateway"
          ? DocsPage.PlatformMcpGateway
          : DocsPage.PlatformAgents,
        "load-tools-when-needed",
      )}
    />
  );
}

/**
 * When users get prompted to connect the servers behind these tools, under the
 * saved choice. The badge and its label come from the wizard's own module, so
 * the choice a reader looks up here is worded exactly as it was worded to
 * whoever made it.
 */
function MissingConnectionRow({
  behavior,
}: {
  behavior: Agent["missingCredentialBehavior"];
}) {
  const option = MISSING_CREDENTIAL_BEHAVIOR_OPTIONS.find(
    (candidate) => candidate.value === behavior,
  );
  if (!option) return null;
  return (
    <SettingRow
      icon={<Unplug className="size-4" />}
      title="Tool connections"
      tone={MISSING_CREDENTIAL_TONE[behavior]}
      state={option.label}
      // The agents page documents the setting for gateways too.
      learnMoreHref={getDocsUrl(DocsPage.PlatformAgents, "tool-connections")}
    />
  );
}

/** The Advisor is a beta capability; the form and LLM settings say so too. */
function BetaBadge() {
  return (
    <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
      Beta
    </Badge>
  );
}

/**
 * One Advisor serves the whole organization, so its model and instructions
 * are not this agent's to set — the row points at where they are.
 */
function AdvisorSettingsLink() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0" asChild>
          <Link href={ADVISOR_SETTINGS_HREF}>
            <Settings2 className="size-4" />
            <span>Advisor settings</span>
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Choose the model the Advisor answers with, in LLM settings. One Advisor
        is shared across the organization.
      </TooltipContent>
    </Tooltip>
  );
}

/** A wrap of skill chips, capped like every other list on the page. */
function SkillPills({
  skills,
  tone,
}: {
  skills: readonly { id: string; name: string }[];
  tone?: "exclude";
}) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {skills.slice(0, PREVIEW_LIMIT).map((skill) => (
        <li key={skill.id}>
          <Pill
            icon={<BookOpen className="size-3.5 shrink-0" />}
            name={skill.name}
            tone={tone}
            href={`/skills/${encodeURIComponent(skill.id)}`}
          />
        </li>
      ))}
      {skills.length > PREVIEW_LIMIT && (
        <li>
          <Badge variant="outline" className="font-normal">
            +{skills.length - PREVIEW_LIMIT} more
          </Badge>
        </li>
      )}
    </ul>
  );
}

function OverviewField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className={typeRole({ role: "label" })}>{label}</div>
      <div className={cn(typeRole({ role: "body" }), "break-words")}>
        {children}
      </div>
    </div>
  );
}

/**
 * An MCP server's own page in the registry — nothing for the synthetic group
 * that stands in for servers this reader cannot see, which has no page.
 */
function mcpServerHref(catalogId: string) {
  return catalogId === UNKNOWN_CATALOG_ID
    ? undefined
    : `/mcp/registry/${encodeURIComponent(catalogId)}`;
}

/** A knowledge connector's own page. */
function knowledgeConnectorHref(connectorId: string) {
  return `/knowledge/connectors/${encodeURIComponent(connectorId)}`;
}

/**
 * The assigned tools per MCP server, so the section reads like the tools
 * editor: one pill per server with its tools under it. A tool whose catalog is
 * not in the list (no permission to read it, or a server removed since) keeps
 * its own group rather than disappearing from a page meant to show the whole
 * assignment.
 */
function groupToolsByCatalog(
  tools: Agent["tools"],
  catalog: { id: string; name: string; icon?: string | null }[],
) {
  const byCatalog = new Map<string, Agent["tools"]>();
  for (const tool of tools) {
    const key = tool.catalogId ?? UNKNOWN_CATALOG_ID;
    const group = byCatalog.get(key);
    if (group) group.push(tool);
    else byCatalog.set(key, [tool]);
  }
  return [...byCatalog.entries()].map(([id, groupedTools]) => {
    const item = catalog.find((entry) => entry.id === id);
    return {
      id,
      name: item?.name ?? "Other tools",
      icon: item?.icon ?? null,
      tools: groupedTools,
    };
  });
}

const UNKNOWN_CATALOG_ID = "__unknown__";

/** Where the instruction is clipped until the reader asks for the rest. */
/** The clipped instruction's height (10rem), a number so the clip can animate to and from it. */
/** The LLM settings page, scrolled to its Advisor block. */
const ADVISOR_SETTINGS_HREF = "/settings/llm#advisor";

const COLLAPSED_PROMPT_HEIGHT_PX = 160;
/** The strip the toggle sits in, under the prompt's last line (`pb-9`). */
const PROMPT_TOGGLE_STRIP_PX = 36;
const PROMPT_EDITOR_LINE_HEIGHT_PX = 20;
const PROMPT_EDITOR_PADDING_PX = 8;

/**
 * The editor as a reader of the prompt, not a writer: no cursor line, no
 * rulers, no scrolling of its own (it is sized to its content and the page
 * scrolls), no context menu — highlighting and a copyable selection remain.
 */
const READ_ONLY_PROMPT_EDITOR_OPTIONS = {
  ariaLabel: "Instruction",
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  lineNumbers: "on",
  lineNumbersMinChars: 3,
  folding: false,
  glyphMargin: false,
  renderLineHighlight: "none",
  occurrencesHighlight: "off",
  selectionHighlight: false,
  matchBrackets: "never",
  contextmenu: false,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  stickyScroll: { enabled: false },
  scrollBeyondLastLine: false,
  scrollbar: {
    vertical: "hidden",
    horizontal: "hidden",
    handleMouseWheel: false,
    alwaysConsumeMouseWheel: false,
  },
  wordWrap: "on",
  automaticLayout: true,
  fontSize: 13,
  lineHeight: PROMPT_EDITOR_LINE_HEIGHT_PX,
  padding: {
    top: PROMPT_EDITOR_PADDING_PX,
    bottom: PROMPT_EDITOR_PADDING_PX,
  },
} as const satisfies NonNullable<EditorProps["options"]>;

/** The editor's height for the prompt before it has wrapped a line of it. */
function estimatePromptHeight(prompt: string) {
  const lines = prompt.split("\n").length;
  return lines * PROMPT_EDITOR_LINE_HEIGHT_PX + 2 * PROMPT_EDITOR_PADDING_PX;
}

/** The status-dot palette the MCP server page uses for deployment state. */
