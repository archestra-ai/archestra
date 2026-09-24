"use client";

import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { Plug, Scale, ShieldCheck, Tags } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useAllCoverageTools,
  useCoverageEntities,
} from "@/lib/openappa-coverage.query";
import { SetupPolicyView } from "./setup-policy-view";
import {
  hasSource,
  type SetupRule,
  type SetupShape,
  setupRuleText,
} from "./setup-rule";
import {
  type PickedTool,
  RuleFlow,
  type SetupCatalog,
} from "./setup-rule-flow";
import { RuleTargets } from "./setup-rule-targets";

export interface RuleDraft {
  shape: SetupShape;
  /** Only used by shapes with a source step. */
  source: PickedTool | null;
  guarded: PickedTool | null;
}

/**
 * The tools a first rule can name: the built-in tools every deployment has,
 * plus the MCP servers the viewer can see.
 */
export function useSetupServers() {
  const appName = useAppName();
  const query = useCoverageEntities({
    type: "mcp_server",
    limit: 100,
    offset: 0,
  });
  const builtIn = useAllCoverageTools(ARCHESTRA_MCP_CATALOG_ID);
  const servers = query.data?.data ?? [];
  const ready = servers.filter((server) => server.toolCount > 0);
  const builtInCount = builtIn.data?.length ?? 0;
  const catalogs: SetupCatalog[] = [
    ...ready.map(({ id, name }) => ({ id, name })),
    ...(builtInCount > 0
      ? [{ id: ARCHESTRA_MCP_CATALOG_ID, name: `${appName} built-in` }]
      : []),
  ];
  return { query, builtIn, servers, ready, builtInCount, catalogs };
}

/** A page of the OpenAPPA site, where the concepts a step introduces are explained. */
export function openAppaUrl(path: string): string {
  return `https://www.openappa.com${path}`;
}

// === Step 0

export function IntroStep() {
  return (
    <div className="space-y-8">
      <div className="max-w-[65ch] space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">
          OpenAPPA checks each tool call before it runs
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          It keeps track of what your agents have read and done, and decides
          what they may do next, using one policy for your organization.
        </p>
        <ExternalDocsLink
          href={openAppaUrl("/how-it-works#the-core-concepts")}
          className="text-sm"
        >
          Learn how OpenAPPA works
        </ExternalDocsLink>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">For example</p>
        <RuleFlow
          shape="flow"
          source={null}
          guarded={null}
          sourcePlaceholder="Read a public GitHub issue"
          guardedPlaceholder="Send an email"
        />
      </div>
      <dl className="grid max-w-[65ch] gap-5">
        <Point icon={<Tags />} term="Conversations carry a security label">
          The label records how far to trust what the agent has read, and who
          may see it. Tool results can make it stricter. Nothing makes it
          looser.
        </Point>
        <Point icon={<Scale />} term="Rules set what a call needs">
          A rule, or tool contract, says how a tool&apos;s result changes the
          label and what a call needs before it runs. In the starting policy,
          tools without a rule have no extra restrictions.
        </Point>
        <Point icon={<ShieldCheck />} term="Blocked calls get a way forward">
          A call that breaks a rule is blocked, and OpenAPPA tells the agent how
          it may continue, such as asking a person to approve that one call.
        </Point>
      </dl>
      <p className="text-sm text-muted-foreground">
        Nothing is saved until the Review step.
      </p>
    </div>
  );
}

function Point({
  icon,
  term,
  children,
}: {
  icon: ReactNode;
  term: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      <dt className="contents">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary [&>svg]:size-4">
          {icon}
        </span>
        <span className="self-center text-sm font-medium">{term}</span>
      </dt>
      <dd className="col-start-2 text-sm leading-relaxed text-muted-foreground">
        {children}
      </dd>
    </div>
  );
}

// === Step 1

export function ToolsStep({
  setup,
}: {
  setup: ReturnType<typeof useSetupServers>;
}) {
  const appName = useAppName();
  const { query, builtIn, servers, ready, builtInCount } = setup;
  return (
    <div className="space-y-6">
      <div className="max-w-[65ch] space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">
          OpenAPPA checks the calls your agents make to these tools
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          These are the tools your first rule can use: the ones built into{" "}
          {appName}, such as{" "}
          <code className="font-mono text-foreground">edit_file</code>, and the
          ones from your MCP servers. The same policy checks their calls through
          the {appName} LLM Proxy and MCP gateways.
        </p>
      </div>
      {query.isPending || builtIn.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : query.isError || builtIn.isError ? (
        <QueryLoadError
          className="h-auto py-8"
          title="Could not load your tools"
          onRetry={() => {
            void query.refetch();
            void builtIn.refetch();
          }}
        />
      ) : ready.length === 0 && builtInCount === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Plug />
            </EmptyMedia>
            <EmptyTitle>No tools yet</EmptyTitle>
            <EmptyDescription>
              Install a server from the MCP Registry, such as GitHub or Slack,
              then come back to write your first rule.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button asChild>
              <Link href="/mcp/registry">Open MCP Registry</Link>
            </Button>
            <Button
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Check again
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="space-y-8">
          {builtInCount > 0 && (
            <ToolSection
              id="setup-tools-built-in"
              title={`Built into ${appName}`}
              description="Tools every agent can use to manage the platform, such as creating agents or editing files."
            >
              <ul className="divide-y rounded-lg border">
                <CatalogRow
                  catalogId={ARCHESTRA_MCP_CATALOG_ID}
                  name={`${appName} built-in tools`}
                  toolCount={builtInCount}
                />
              </ul>
            </ToolSection>
          )}
          <ToolSection
            id="setup-tools-servers"
            title="Your MCP servers"
            meta={ready.length > 0 ? `${ready.length} with tools` : undefined}
            description="Servers installed from the MCP Registry, such as GitHub or Slack. They are usually where outside content, like issues, web pages or emails, comes in."
          >
            {ready.length === 0 && (
              <InlineNotice variant="info">
                <Plug />
                <span className="font-medium">
                  You only have built-in tools.
                </span>
                <InlineNoticeText>
                  A rule about outside content needs a tool that reads it.
                  Connect a server first, or continue with a built-in tool.
                </InlineNoticeText>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7"
                  asChild
                >
                  <Link href="/mcp/registry">Open MCP Registry</Link>
                </Button>
              </InlineNotice>
            )}
            {servers.length > 0 && (
              <ul className="divide-y rounded-lg border">
                {[...servers]
                  .sort(
                    (a, b) => Number(b.toolCount > 0) - Number(a.toolCount > 0),
                  )
                  .map((server) => (
                    <CatalogRow
                      key={server.id}
                      catalogId={server.id}
                      icon={server.icon}
                      name={server.name}
                      toolCount={server.toolCount}
                    />
                  ))}
              </ul>
            )}
          </ToolSection>
        </div>
      )}
    </div>
  );
}

function ToolSection({
  id,
  title,
  meta,
  description,
  children,
}: {
  id: string;
  title: string;
  meta?: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="max-w-[65ch] space-y-1">
        <div className="flex items-baseline gap-2">
          <h3 id={id} className="text-sm font-medium">
            {title}
          </h3>
          {meta && (
            <span className="text-xs text-muted-foreground">{meta}</span>
          )}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

function CatalogRow({
  catalogId,
  icon = null,
  name,
  toolCount,
}: {
  catalogId: string;
  icon?: string | null;
  name: string;
  toolCount: number;
}) {
  const ready = toolCount > 0;
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <McpCatalogIcon icon={icon} catalogId={catalogId} size={20} />
      <span
        className={
          ready
            ? "min-w-0 flex-1 truncate text-sm font-medium"
            : "min-w-0 flex-1 truncate text-sm text-muted-foreground"
        }
      >
        {name}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {ready
          ? `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`
          : "No tools synced"}
      </span>
    </li>
  );
}

// === Step 2

const STARTERS: { shape: SetupShape; title: string; example: string }[] = [
  {
    shape: "flow",
    title: "Ask before acting on outside content",
    example: "After reading a web page, sending an email waits for a person.",
  },
  {
    shape: "audience",
    title: "Ask before sharing internal data publicly",
    example:
      "After reading a customer record, opening a public GitHub issue waits for a person.",
  },
  {
    shape: "tool",
    title: "Ask before using a tool",
    example: "Every call to edit_file waits for a person.",
  },
  {
    shape: "repeat",
    title: "Ask before using a tool again",
    example:
      "The first email goes out. Every email after it waits for a person.",
  },
];

export function RuleStep({
  catalogs,
  draft,
  policy,
  onChange,
  errors,
}: {
  catalogs: SetupCatalog[];
  draft: RuleDraft;
  /** The saved policy text, so the preview leaves out what it already declares. */
  policy: string;
  onChange: (draft: RuleDraft) => void;
  errors: string[];
}) {
  const paired = hasSource(draft.shape);
  return (
    <div className="space-y-8">
      <div className="max-w-[65ch] space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">
          Choose your first rule
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each starter rule makes a tool call wait for a person&apos;s approval.
          An approval covers that one call, never the ones after it. Pick a
          kind, then pick your own tools in the picture. The examples only
          illustrate each kind.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          You can change or remove this rule at any time from the policy page,
          so there is no need to get it perfect now.
        </p>
      </div>
      <RadioGroup
        aria-label="Start from"
        value={draft.shape}
        onValueChange={(shape) =>
          onChange({ ...draft, shape: shape as SetupShape })
        }
        className="grid gap-2 sm:grid-cols-2"
      >
        {STARTERS.map((starter) => {
          const value = starter.shape;
          return (
            <Label
              key={value}
              htmlFor={`setup-starter-${value}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
            >
              <RadioGroupItem
                id={`setup-starter-${value}`}
                value={value}
                className="mt-0.5"
              />
              <span className="grid gap-1">
                <span className="text-sm font-medium">{starter.title}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground/80">
                    Example:
                  </span>{" "}
                  <span>{starter.example}</span>
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      <div className="space-y-3">
        <div className="max-w-[65ch] space-y-1">
          <p className="text-sm font-medium">Your rule</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <span>
              {paired
                ? "Pick a tool that reads in box 1, then a tool that acts in box 3. Each list shows only the tools that fit."
                : "Pick the tool that needs approval. The list shows tools that change something, such as editing a file or sending a message."}
            </span>{" "}
            <ExternalDocsLink
              key={draft.shape}
              href={openAppaUrl(SHAPE_DOCS[draft.shape].path)}
            >
              {SHAPE_DOCS[draft.shape].label}
            </ExternalDocsLink>
          </p>
        </div>
        <RuleFlow
          shape={draft.shape}
          source={draft.source}
          guarded={draft.guarded}
          edit={{
            catalogs,
            onSource: (source) =>
              onChange({
                ...draft,
                source,
                guarded:
                  draft.guarded?.fullName === source.fullName
                    ? null
                    : draft.guarded,
              }),
            onGuarded: (guarded) =>
              onChange({
                ...draft,
                source:
                  draft.source?.fullName === guarded.fullName
                    ? null
                    : draft.source,
                guarded,
              }),
          }}
        />
      </div>
      {errors.length > 0 && (
        <InlineNotice variant="error">
          <span className="font-medium">
            This rule did not pass validation.
          </span>
          <InlineNoticeText>{errors.join(" ")}</InlineNoticeText>
        </InlineNotice>
      )}
      <SetupPolicyView
        trigger="Show the policy text this adds"
        ariaLabel="Policy text the rule adds"
        content={setupRuleText(previewRule(draft), policy)}
        help={
          <ExternalDocsLink href={openAppaUrl("/contracts#tool-contracts")}>
            What these fields mean
          </ExternalDocsLink>
        }
      />
    </div>
  );
}

/** Where the OpenAPPA site explains the idea each kind of rule is built on. */
const SHAPE_DOCS: Record<SetupShape, { path: string; label: string }> = {
  flow: { path: "/contracts#trust", label: "Learn how trust works" },
  audience: { path: "/contracts#audiences", label: "Learn how audiences work" },
  tool: { path: "/contracts#attention", label: "Learn how approval works" },
  repeat: { path: "/contracts#effects", label: "Learn how effects work" },
};

/** The draft's rule, with a stand-in for each tool not picked yet. */
function previewRule(draft: RuleDraft): SetupRule {
  return {
    shape: draft.shape,
    source: hasSource(draft.shape)
      ? (draft.source?.fullName ?? "<tool that reads>")
      : undefined,
    guarded: draft.guarded?.fullName ?? "<tool that acts>",
  };
}

/** The rule a draft describes, once every tool it needs is picked. */
export function draftRule(draft: RuleDraft): SetupRule | null {
  if (!draft.guarded) return null;
  if (!hasSource(draft.shape))
    return { shape: draft.shape, guarded: draft.guarded.fullName };
  if (!draft.source || draft.source.fullName === draft.guarded.fullName)
    return null;
  return {
    shape: draft.shape,
    source: draft.source.fullName,
    guarded: draft.guarded.fullName,
  };
}

/** The tools a draft names, in the order the rule meets them. */
function ruleTools(draft: RuleDraft): PickedTool[] {
  return [hasSource(draft.shape) ? draft.source : null, draft.guarded].filter(
    (tool) => tool !== null,
  );
}

/** The draft as one sentence, for the summary and the finish screen. */
export function RuleSentence({ draft }: { draft: RuleDraft }) {
  const guarded = (
    <code className="font-mono text-foreground">{draft.guarded?.name}</code>
  );
  if (hasSource(draft.shape))
    return (
      <span>
        After an agent calls{" "}
        <code className="font-mono text-foreground">{draft.source?.name}</code>,{" "}
        {guarded} waits for a person to approve it.
      </span>
    );
  if (draft.shape === "repeat")
    return (
      <span>
        After the first successful call to {guarded} in a conversation, each
        further call waits for a person to approve it.
      </span>
    );
  return <span>Every call to {guarded} waits for a person to approve it.</span>;
}

// === Step 3

export function EnableStep({
  draft,
  alreadyOn,
  policy,
  notice,
}: {
  draft: RuleDraft | null;
  alreadyOn: boolean;
  /** The whole policy as it will be saved, and where the rule sits in it. */
  policy: { content: string; added?: { from: number; to: number } } | null;
  notice: ReactNode;
}) {
  const appName = useAppName();
  return (
    <div className="space-y-6">
      <div className="max-w-[65ch] space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">
          {!alreadyOn
            ? "Review before you turn it on"
            : draft
              ? "Review your rule"
              : "OpenAPPA is already on"}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {!alreadyOn
            ? "Check what changes and where it applies. Nothing is saved until you confirm, and you can turn OpenAPPA off from the sidebar at any time."
            : draft
              ? "OpenAPPA is already on. Saving adds this rule to your policy."
              : "There is nothing to save. Continue to see what to do next."}
        </p>
      </div>
      <dl className="divide-y rounded-lg border">
        <SummaryRow term="Your rule">
          {draft ? (
            <span className="grid justify-items-start gap-1">
              <RuleSentence draft={draft} />
              <ExternalDocsLink href={openAppaUrl("/how-it-works#authorities")}>
                Learn how approvals work
              </ExternalDocsLink>
            </span>
          ) : (
            <span>No new rule. Your policy stays as it is.</span>
          )}
        </SummaryRow>
        <SummaryRow term="What is checked">
          Tool calls through the {appName} LLM Proxy and MCP gateways, including
          chat.
        </SummaryRow>
        <SummaryRow term="When it applies">
          New conversations. A conversation keeps the policy it started with.
        </SummaryRow>
        {!alreadyOn && (
          <SummaryRow term="Scope">
            The switch covers every organization on this deployment.
          </SummaryRow>
        )}
      </dl>
      {draft && <RuleTargets tools={ruleTools(draft)} />}
      {draft && <RuleOverlaps tools={ruleTools(draft)} />}
      {policy && (
        <SetupPolicyView
          trigger={
            policy.added ? "Show the policy this saves" : "Show the policy"
          }
          ariaLabel="Organization guardrails policy"
          content={policy.content}
          added={policy.added}
        />
      )}
      {notice}
    </div>
  );
}

/**
 * The first matching rule wins, and root rules come before batteries: an
 * earlier root rule for a picked tool keeps this one from applying, and this
 * one replaces a battery's rule for it.
 */
function RuleOverlaps({ tools }: { tools: PickedTool[] }) {
  const shadowed = tools.filter((tool) => tool.rule?.source === "root");
  const replaced = tools.filter((tool) => tool.rule?.source === "battery");
  const names = (list: PickedTool[]) =>
    list.map((tool, index) => (
      <span key={tool.fullName}>
        {index > 0 && <span> and </span>}
        <code className="font-mono">{tool.name}</code>
      </span>
    ));
  return (
    <>
      {shadowed.length > 0 && (
        <InlineNotice variant="warning">
          <span className="font-medium">
            Your policy already has a rule for {names(shadowed)}.
          </span>
          <InlineNoticeText>
            OpenAPPA uses the first rule that matches a tool, so the earlier
            rule still decides. Pick another tool, or change that rule on the
            policy page.
          </InlineNoticeText>
        </InlineNotice>
      )}
      {replaced.length > 0 && (
        <InlineNotice variant="info">
          <span className="font-medium">
            This rule replaces a battery rule for {names(replaced)}.
          </span>
          <InlineNoticeText>
            Rules in your policy come before battery rules, so OpenAPPA uses
            this one instead of the battery&apos;s.{" "}
            <ExternalDocsLink
              href={openAppaUrl(
                "/batteries#policy-order-when-batteries-are-used",
              )}
            >
              Learn how the order works
            </ExternalDocsLink>
          </InlineNoticeText>
        </InlineNotice>
      )}
    </>
  );
}

function SummaryRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm font-medium">{term}</dt>
      <dd className="text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}
