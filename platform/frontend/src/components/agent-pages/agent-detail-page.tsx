"use client";

import { E2eTestId } from "@archestra/shared";
import {
  Copy,
  Download,
  History,
  MessageSquare,
  MoreHorizontal,
  PackageX,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ConvertToSkillDialog } from "@/app/agents/convert-to-skill-dialog";
import { AgentBadge } from "@/components/agent-badge";
import { AgentIcon } from "@/components/agent-icon";
import { AgentVersionHistoryDialog } from "@/components/agent-version-history-dialog";
import { CloneAgentDialog } from "@/components/clone-agent-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { OverviewSummary } from "@/components/overview-summary";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDeleteProfile,
  useExportAgent,
  useProfile,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { formatPermissionConstraint } from "@/lib/auth/auth.utils";
import { useFeature } from "@/lib/config/config.query";
import {
  backToListLabel,
  notYoursToChange,
} from "@/lib/design/resource-lexicon";
import { useEnvironments } from "@/lib/environment.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import {
  agentAction,
  agentActionHref,
  getAgentActionModel,
} from "./agent-actions-model";
import { AgentBackgroundExecutionCard } from "./agent-background-execution-card";
import { AgentConnectContent } from "./agent-connect-content";
import { AgentExecutions } from "./agent-executions";
import { useAgentOverviewFacts } from "./agent-overview";
import {
  AGENT_PAGE_CONFIGS,
  type AgentPageKind,
  agentDetailHref,
  agentEditHref,
  agentListHref,
  agentPageKindForType,
  isAgentTypeAllowedOnPage,
} from "./agent-page-config";
import { AgentSystemPromptCard } from "./agent-system-prompt-card";
import { useAgentAccess } from "./use-agent-access";

/**
 * `/<family>/[id]` — one agent-shaped resource's page: header with the
 * actions the list row used to offer, the essential record facts, and the
 * connection instructions on the same page.
 *
 * Trashed records are not routable: `GET /api/agents/:id` filters them out, so
 * they only ever reach the not-found state. Restore and permanent delete stay
 * row actions on the list's trash view.
 */
export function AgentDetailPage({
  kind,
  id,
}: {
  kind: AgentPageKind;
  id: string;
}) {
  const config = AGENT_PAGE_CONFIGS[kind];
  const router = useRouter();
  const { data: agent, isPending, isError, refetch } = useProfile(id);

  // Deleting this record invalidates the query, and the refetch answers with
  // "not found" long before the navigation back to the list resolves. Keep the
  // page in its loading state for that window rather than flashing a 404 for
  // a delete that just succeeded.
  const [isLeavingAfterDelete, setIsLeavingAfterDelete] = useState(false);

  useEffect(() => {
    if (agent && !isAgentTypeAllowedOnPage(kind, agent.agentType)) {
      router.replace(
        agentDetailHref(agentPageKindForType(agent.agentType), id),
      );
    }
  }, [agent, kind, id, router]);

  const backLink = (
    <PageBackLink href={agentListHref(kind)}>
      {backToListLabel(kind)}
    </PageBackLink>
  );

  if (isPending || (isLeavingAfterDelete && !agent)) {
    return (
      <PageLayout
        title={config.singular}
        description=""
        backLink={backLink}
        maxWidth="wizard"
        minWidth="phone"
      >
        <DetailPageSkeleton />
      </PageLayout>
    );
  }

  if (isError && !agent) {
    // The request failed rather than answering "no such record" — a 404 comes
    // back as a successful null. Offer a retry instead of claiming the record
    // is gone.
    return (
      <PageLayout
        title={config.singular}
        description=""
        backLink={backLink}
        maxWidth="wizard"
        minWidth="phone"
      >
        <QueryLoadError
          className="border"
          title={`Couldn't load this ${config.singularInSentence}`}
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }

  if (!agent) {
    return (
      <PageLayout
        title={config.singular}
        description=""
        backLink={backLink}
        maxWidth="wizard"
        minWidth="phone"
      >
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageX />
            </EmptyMedia>
            <EmptyTitle>{config.singular} not found</EmptyTitle>
            <EmptyDescription>
              This {config.singularInSentence} does not exist or is not visible
              to you. It may have been removed.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageLayout>
    );
  }

  return (
    <AgentDetails
      kind={kind}
      agent={agent}
      backLink={backLink}
      onDeleted={() => {
        setIsLeavingAfterDelete(true);
        router.push(agentListHref(kind));
      }}
    />
  );
}

type Agent = NonNullable<ReturnType<typeof useProfile>["data"]>;

function AgentDetails({
  kind,
  agent,
  backLink,
  onDeleted,
}: {
  kind: AgentPageKind;
  agent: Agent;
  backLink: React.ReactNode;
  /** Owned by the page so it can suppress its not-found state on the way out. */
  onDeleted: () => void;
}) {
  const config = AGENT_PAGE_CONFIGS[kind];
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: environmentsData } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();
  const {
    resource,
    canModify,
    canUpdate,
    canEdit,
    canCreate,
    canDelete,
    isBuiltIn,
    isPending: isAccessPending,
  } = useAgentAccess(agent, kind);
  const actionModel = getAgentActionModel({ kind, agent });
  const connectAction = agentAction(actionModel, "connect");
  const chatAction = agentAction(actionModel, "chat");
  const editAction = agentAction(actionModel, "edit");
  const cloneAction = agentAction(actionModel, "clone");
  const exportAction = agentAction(actionModel, "export");
  const historyAction = agentAction(actionModel, "history");
  const convertAction = agentAction(actionModel, "convert");
  const deleteAction = agentAction(actionModel, "delete");
  const environmentName = agent.environmentId
    ? environmentsData?.environments.find(
        (environment) => environment.id === agent.environmentId,
      )?.name
    : defaultEnvironment.name;
  // The record's own resource, not the route family's: a legacy profile shown
  // under the proxy pages is authorized as an `agent` everywhere, version
  // history included.
  const { data: canReadResource } = useHasPermissions({
    [resource]: ["read"],
  });
  const { data: canCreateSkill } = useHasPermissions({ skill: ["create"] });

  const showConnect = connectAction.visible;
  const legacyConnectRequested = searchParams.get("tab") === "connect";
  const backgroundExecutionEnabled =
    useFeature("agentBackgroundExecution") === true;
  const hasBackgroundExecution =
    backgroundExecutionEnabled &&
    kind === "agent" &&
    agent.backgroundExecution != null;
  const showingExecutions =
    hasBackgroundExecution && searchParams.get("tab") === "executions";
  const detailHref = agentDetailHref(kind, agent.id);

  useEffect(() => {
    if (!legacyConnectRequested || !showConnect) return;
    document
      .getElementById(AGENT_CONNECT_SECTION_ID)
      ?.scrollIntoView({ block: "start" });
  }, [legacyConnectRequested, showConnect]);

  // The record's key configuration, as one always-visible row.
  const overviewFacts = useAgentOverviewFacts({ kind, agent });

  const [cloning, setCloning] = useState(false);
  const [converting, setConverting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteRequested, setDeleteRequested] = useState(false);
  const exportAgent = useExportAgent();
  const deleteAgent = useDeleteProfile();

  // Export and Convert to skill exist on the agents family alone, so on the
  // other two they are absent rather than refused: there is no such action for
  // the menu to refuse. Everything the family does offer stays in the menu
  // with its reason.
  const hasExport = kind === "agent";
  const hasConvertToSkill = kind === "agent";
  // Why a mutating action is refused, when it is refused. Built-in records
  // belong to nobody and are org-wide, so they answer to the resource admin
  // rather than to the scope check every other record answers to. The name
  // comes from the lexicon rather than from lowercasing the title-case plural,
  // which turned "MCP Gateways" into "mcp gateways".
  const refusalReason = isBuiltIn
    ? `Only an administrator can change a built-in ${config.singularInSentence}`
    : notYoursToChange({ resource: kind, scope: agent.scope });
  // One reason per refusal, and the true one: a reader who holds no `create`
  // is refused by RBAC, not by whose record this is.
  const cloneReason = isBuiltIn
    ? `A built-in ${config.singularInSentence} cannot be cloned`
    : canCreate
      ? undefined
      : formatPermissionConstraint({ [resource]: ["create"] });
  const exportReason = isBuiltIn
    ? `A built-in ${config.singularInSentence} cannot be exported`
    : undefined;
  const historyReason = canReadResource
    ? undefined
    : formatPermissionConstraint({ [resource]: ["read"] });
  const convertReason = isBuiltIn
    ? `A built-in ${config.singularInSentence} cannot be converted to a skill`
    : canCreateSkill
      ? undefined
      : formatPermissionConstraint({ skill: ["create"] });
  // `canDelete` is the delete permission AND the scope check AND not built-in,
  // so which of the three refused decides which sentence is the true one.
  const deleteReason = canDelete
    ? undefined
    : isBuiltIn
      ? `A built-in ${config.singularInSentence} cannot be deleted`
      : canModify
        ? formatPermissionConstraint({ [resource]: ["delete"] })
        : refusalReason;

  const handleExport = () => {
    exportAgent.mutate(agent.id, {
      onSuccess: (data) => {
        if (!data) return;
        const blob = new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${agent.name.replace(/\s+/g, "-").toLowerCase()}-agent.json`;
        a.click();
        URL.revokeObjectURL(url);
      },
    });
  };

  return (
    <PageLayout
      // The wizard's column, so Edit opens in the same one this page reads in.
      maxWidth="wizard"
      minWidth="phone"
      title={
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <AgentIcon
              icon={agent.icon}
              fallbackType={config.defaultIconType}
              size={24}
            />
          </div>
          <span className="min-w-0 truncate">{agent.name}</span>
          <AgentBadge
            type={isBuiltIn ? "builtIn" : agent.scope}
            className="font-normal"
          />
          {kind === "mcp_gateway" && environmentName && (
            <Badge variant="outline" className="font-normal">
              {environmentName}
            </Badge>
          )}
        </div>
      }
      documentTitle={agent.name}
      backLink={backLink}
      description={agent.description ?? ""}
      tabs={
        hasBackgroundExecution
          ? [
              {
                label: "Overview",
                href: detailHref,
                selected: !showingExecutions,
              },
              {
                label: "Executions",
                href: `${detailHref}?tab=executions`,
                selected: showingExecutions,
              },
            ]
          : []
      }
      actionButton={
        // One primary (Edit), one secondary (Chat), the rest in the kebab with
        // the destructive item under a divider.
        <div className="flex shrink-0 items-center gap-2">
          {chatAction.visible && chatAction.href && (
            <Button variant="outline" asChild>
              <Link href={chatAction.href}>
                <MessageSquare className="h-4 w-4" />
                {chatAction.label}
              </Link>
            </Button>
          )}
          {/* Refused, not removed: a reader who simply cannot see Edit has no
              way to learn the record is not theirs to change. Undecided is not
              refused either, so while the permission reads are in flight the
              header holds the button's space rather than stating a reason that
              is about to stop being true. */}
          {isAccessPending ? (
            <Skeleton className="h-9 w-24" />
          ) : canEdit ? (
            <Button asChild data-testid={E2eTestId.AgentDetailEditButton}>
              <Link href={agentActionHref(editAction)}>
                <Pencil className="h-4 w-4" />
                {editAction.label}
              </Link>
            </Button>
          ) : (
            <PermissionButton
              permissions={{ [resource]: ["update"] }}
              // The ownership sentence is the right one only for a reader who
              // holds the update permission; without it PermissionButton states
              // the permission constraint, which is what actually refused them.
              disabled={canUpdate}
              tooltip={canUpdate ? refusalReason : undefined}
              data-testid={E2eTestId.AgentDetailEditButton}
            >
              <Pencil className="h-4 w-4" />
              {editAction.label}
            </PermissionButton>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* Every item this family offers is here whether or not the
                  reader may take it: an action that vanishes leaves them
                  nothing to read, and a menu whose items all vanish opens on
                  its own divider. */}
              <KebabItem
                icon={<Copy className="h-4 w-4" />}
                label={cloneAction.label}
                reason={cloneReason}
                onSelect={() => setCloning(true)}
              />
              {hasExport && (
                <KebabItem
                  icon={<Download className="h-4 w-4" />}
                  label={exportAction.label}
                  reason={exportReason}
                  isBusy={exportAgent.isPending}
                  onSelect={handleExport}
                />
              )}
              <KebabItem
                icon={<History className="h-4 w-4" />}
                label={historyAction.label}
                reason={historyReason}
                onSelect={() => setHistoryOpen(true)}
              />
              {hasConvertToSkill && (
                <KebabItem
                  icon={<Sparkles className="h-4 w-4" />}
                  label={convertAction.label}
                  reason={convertReason}
                  onSelect={() => setConverting(true)}
                />
              )}
              <DropdownMenuSeparator />
              <KebabItem
                variant="destructive"
                icon={<Trash2 className="h-4 w-4" />}
                label={deleteAction.label}
                reason={deleteReason}
                onSelect={() => setDeleteRequested(true)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      {/*
        One gap for the whole page. Once Connect lost its heading the body
        became a single run of cards, so the wider band that used to separate
        two titled sections now fell between the Overview card and Endpoint —
        40px there against 16px between every card below it.
      */}
      {showingExecutions ? (
        <AgentExecutions agentId={agent.id} />
      ) : (
        <div className="space-y-4">
          <OverviewSummary
            headingId="agent-overview-heading"
            facts={overviewFacts}
            configHref={canEdit ? agentActionHref(editAction) : undefined}
            configLabel="Full configuration"
          />

          {kind === "agent" && (
            <AgentSystemPromptCard
              key={agent.id}
              agent={agent}
              readOnly={!canEdit}
              builtInAgentName={agent.builtInAgentConfig?.name}
            />
          )}

          {hasBackgroundExecution && (
            <AgentBackgroundExecutionCard
              agentId={agent.id}
              credentials={agent.backgroundExecution?.credentials ?? []}
              readOnly
              editHref={
                canEdit ? agentEditHref(kind, agent.id, "advanced") : undefined
              }
            />
          )}

          {showConnect && (
            // No heading of its own: the cards inside are already titled
            // "Endpoint" and "Authentication", and a "Connect" band above them
            // named neither, while colliding with the Connect page the footer
            // link points at.
            <section
              id={AGENT_CONNECT_SECTION_ID}
              className="scroll-mt-24 space-y-4"
            >
              <AgentConnectContent kind={kind} agent={agent} origin="table" />
            </section>
          )}
        </div>
      )}

      <CloneAgentDialog
        agent={cloning ? agent : null}
        onOpenChange={(open) => {
          if (!open) setCloning(false);
        }}
        onCloned={(cloned) => {
          // Land on the clone's Configuration step so it can be renamed
          // straight away.
          router.push(agentEditHref(kind, cloned.id, "configuration"));
        }}
      />
      {kind === "agent" && (
        <ConvertToSkillDialog
          agent={converting ? agent : null}
          onOpenChange={(open) => {
            if (!open) setConverting(false);
          }}
        />
      )}
      <AgentVersionHistoryDialog
        agentId={historyOpen ? agent.id : null}
        canModify={canModify}
        onOpenChange={(open) => {
          if (!open) setHistoryOpen(false);
        }}
      />
      {deleteRequested && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteRequested(false);
          }}
          title={`Delete ${config.singular}`}
          description={`Are you sure you want to delete this ${config.singular}? This action cannot be undone.`}
          isPending={deleteAgent.isPending}
          // `mutate` with callbacks rather than an awaited `mutateAsync`: the
          // query layer rejects on failure (and toasts), and an unhandled
          // rejection here would take the page down instead.
          onConfirm={() => {
            deleteAgent.mutate(agent.id, {
              onSuccess: (result) => {
                if (!result) return;
                toast.success(`${config.singular} deleted successfully`);
                setDeleteRequested(false);
                onDeleted();
              },
            });
          }}
          confirmLabel={`Delete ${config.singular}`}
          pendingLabel="Deleting..."
        />
      )}
    </PageLayout>
  );
}

/**
 * One item of the header's kebab, refused in place rather than removed.
 *
 * `reason` is why the reader may not take the action, and `undefined` means
 * they may. `aria-disabled` rather than Radix's `disabled`: a disabled item is
 * taken out of the menu's roving focus and typeahead, which would put the
 * reason out of reach of exactly the users it is written for. The refusal is
 * enforced by preventing the select and the click instead.
 */
function KebabItem({
  icon,
  label,
  reason,
  isBusy,
  variant,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  reason?: string;
  /** Permitted, but already running: taking it again would export twice. */
  isBusy?: boolean;
  variant?: "destructive";
  onSelect: () => void;
}) {
  const reasonId = useId();
  const isDisabled = !!reason || !!isBusy;

  return (
    <DropdownMenuItem
      variant={variant}
      aria-disabled={isDisabled || undefined}
      aria-describedby={reason ? reasonId : undefined}
      className={isDisabled ? "cursor-not-allowed opacity-50" : undefined}
      onSelect={(event) => {
        if (isDisabled) event.preventDefault();
      }}
      onClick={(event) => {
        if (isDisabled) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
    >
      {icon}
      {label}
      {/* The reason as text, not only as a tooltip: a menu item reached by
          keyboard never opens one. `aria-hidden` keeps it out of the accessible
          name, where it would duplicate the description a screen reader already
          reads from `aria-describedby`. */}
      {reason && (
        <span id={reasonId} aria-hidden="true" className="sr-only">
          {reason}
        </span>
      )}
    </DropdownMenuItem>
  );
}

const AGENT_CONNECT_SECTION_ID = "connect";

function DetailPageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
