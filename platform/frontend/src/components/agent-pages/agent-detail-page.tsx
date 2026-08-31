"use client";

import { DocsPage, E2eTestId, getDocsUrl } from "@archestra/shared";
import {
  Copy,
  Download,
  History,
  Info,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PackageX,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ConvertToSkillDialog } from "@/app/agents/convert-to-skill-dialog";
import { AgentBadge } from "@/components/agent-badge";
import { AgentForm } from "@/components/agent-form";
import { AgentIcon } from "@/components/agent-icon";
import { AgentVersionHistoryDialog } from "@/components/agent-version-history-dialog";
import { CloneAgentDialog } from "@/components/clone-agent-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
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
import { agentAction, getAgentActionModel } from "./agent-actions-model";
import { AgentConnectContent } from "./agent-connect-content";
import { AgentExecutions } from "./agent-executions";
import {
  AGENT_PAGE_CONFIGS,
  type AgentDetailTab,
  type AgentPageKind,
  agentConfigureHref,
  agentDetailHref,
  agentListHref,
  agentPageKindForType,
  getAgentSetupSteps,
  isAgentTypeAllowedOnPage,
  resolveAgentDetailTab,
} from "./agent-page-config";
import { useAgentAccess } from "./use-agent-access";

/**
 * `/<family>/[id]` — one agent-shaped resource's page. Its configuration is
 * edited here, in tabs, rather than behind an Edit button that opened a
 * wizard on a second route: the record's settings are the page.
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

  // Hold the last record this mount saw. Deleting the agent in another tab (or
  // any background refetch that answers 404) turns `data` into null, and
  // dropping the page on that would throw away whatever the user has typed
  // into the configuration since. The page stays up on the held copy and says
  // the record is gone.
  const heldAgentRef = useRef<Agent | null>(null);
  if (agent) heldAgentRef.current = agent;
  const heldAgent = agent ?? heldAgentRef.current;
  // A successful null after we had a record — not a failed request, which
  // leaves the previous data in place.
  const isGone = !agent && !!heldAgentRef.current;

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

  if (heldAgent && !isLeavingAfterDelete) {
    return (
      <AgentDetails
        kind={kind}
        agent={heldAgent}
        isGone={isGone}
        backLink={backLink}
        onDeleted={() => {
          setIsLeavingAfterDelete(true);
          router.push(agentListHref(kind));
        }}
      />
    );
  }

  const shell = (children: React.ReactNode) => (
    <PageLayout
      title={config.singular}
      description=""
      backLink={backLink}
      maxWidth="wizard"
      minWidth="phone"
    >
      {children}
    </PageLayout>
  );

  if (isPending || isLeavingAfterDelete) {
    return shell(<DetailPageSkeleton />);
  }

  if (isError) {
    // The request failed rather than answering "no such record" — a 404 comes
    // back as a successful null. Offer a retry instead of claiming the record
    // is gone.
    return shell(
      <QueryLoadError
        className="border"
        title={`Couldn't load this ${config.singularInSentence}`}
        onRetry={() => refetch()}
      />,
    );
  }

  return shell(
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackageX />
        </EmptyMedia>
        <EmptyTitle>{config.singular} not found</EmptyTitle>
        <EmptyDescription>
          This {config.singularInSentence} does not exist or is not visible to
          you. It may have been removed.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>,
  );
}

type Agent = NonNullable<ReturnType<typeof useProfile>["data"]>;

function AgentDetails({
  kind,
  agent,
  isGone,
  backLink,
  onDeleted,
}: {
  kind: AgentPageKind;
  agent: Agent;
  /** The record has since been deleted; this is the last copy we hold. */
  isGone: boolean;
  backLink: React.ReactNode;
  /** Owned by the page so it can suppress its not-found state on the way out. */
  onDeleted: () => void;
}) {
  const config = AGENT_PAGE_CONFIGS[kind];
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: environmentsData } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();
  const {
    resource,
    canModify,
    canEdit,
    canCreate,
    canDelete,
    isBuiltIn,
    isPending: isAccessPending,
  } = useAgentAccess(agent, kind);
  const actionModel = getAgentActionModel({ kind, agent });
  const connectAction = agentAction(actionModel, "connect");
  const chatAction = agentAction(actionModel, "chat");
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
  const backgroundExecutionEnabled =
    useFeature("agentBackgroundExecution") === true;
  const hasBackgroundExecution =
    backgroundExecutionEnabled &&
    kind === "agent" &&
    agent.backgroundExecution != null;

  // The record's configuration is this page's tabs, in the order the setup
  // wizard walks them; Connect and Executions are the two views onto a
  // configured record and follow them.
  const steps = getAgentSetupSteps({
    agentType: agent.agentType,
    builtIn: isBuiltIn,
  });
  const tabs: AgentDetailTab[] = [
    ...steps.map((step) => step.id),
    ...(showConnect ? (["connect"] as const) : []),
    ...(hasBackgroundExecution ? (["executions"] as const) : []),
  ];
  const tabParam = searchParams.get("tab");
  const tab = resolveAgentDetailTab(tabs, tabParam);
  // Which configuration section is on screen, if any. Connect and Executions
  // are not sections of the form, so they answer undefined and the form is
  // not mounted at all.
  const activeStep = steps.find((step) => step.id === tab)?.id;

  // A `?tab=` this record has no tab for (a gateway sent to `?tab=executions`,
  // or a typo) silently resolves to the first one. Correct the URL to match,
  // so a reload, a copied link or the back button does not keep asking for a
  // tab that is not on this page.
  useEffect(() => {
    if (!tabParam || tabParam === tab) return;
    router.replace(agentDetailHref(kind, agent.id, tab), { scroll: false });
  }, [tabParam, tab, kind, agent.id, router]);

  // Unsaved edits guard every way off the current tab that is not a save:
  // another tab, the back link, the header's own links. The pending
  // destination is parked here and taken once the guard lets go.
  const [isDirty, setIsDirty] = useState(false);
  useBeforeUnloadWhileDirty(isDirty);
  const pendingHrefRef = useRef<string | null>(null);
  const guard = useUnsavedChangesGuard({
    isDirty,
    onOpenChange: (open) => {
      if (open) return;
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      // A tab change is the same page with another query, so it replaces
      // rather than stacking a history entry per tab.
      if (href) {
        if (href.startsWith(pathname)) router.replace(href, { scroll: false });
        else router.push(href);
      }
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard],
  );

  // `?openTools=true` (from "add tools to this gateway" links) pops the tools
  // picker open on the tools tab. "All" gateways hide the tool editor (there
  // is nothing to pick), so only Custom ones get the auto-open.
  const openToolsCombobox =
    tab === "tools" &&
    searchParams.get("openTools") === "true" &&
    !agent.accessAllTools;

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

  const formAgentType = agent.agentType === "profile" ? "profile" : kind;

  return (
    <PageLayout
      // The wizard's column, so a record reads and edits in the same one it
      // was created in.
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
      description={
        isBuiltIn && agent.description ? (
          <>
            {agent.description.replace(/\.?$/, ".")}{" "}
            <ExternalDocsLink
              href={getDocsUrl(DocsPage.PlatformBuiltInSubagents)}
              className="underline"
              showIcon={false}
            >
              Learn more
            </ExternalDocsLink>
          </>
        ) : (
          (agent.description ?? "")
        )
      }
      tabs={
        // A single-tab page is not a tabbed one: a built-in record has only
        // its Configuration, so it renders no bar naming it.
        tabs.length > 1
          ? tabs.map((entry) => ({
              label: AGENT_DETAIL_TAB_LABELS[entry],
              href: agentDetailHref(kind, agent.id, entry),
              testId: `${E2eTestId.AgentSetupStep}-${entry}`,
              selected: entry === tab,
            }))
          : []
      }
      onTabNavigate={(href, event) => {
        if (!isDirty) return;
        event.preventDefault();
        requestNavigate(href);
      }}
      actionButton={
        // Configuration is the page itself now, so the header carries only
        // what the page cannot: chatting with the record, and the actions
        // that act on it as a whole.
        <div className="flex shrink-0 items-center gap-2">
          {chatAction.visible && chatAction.href && (
            <Button variant="outline" asChild>
              <Link href={chatAction.href}>
                <MessageSquare className="h-4 w-4" />
                {chatAction.label}
              </Link>
            </Button>
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
      {tab === "executions" ? (
        <AgentExecutions agentId={agent.id} />
      ) : tab === "connect" ? (
        <AgentConnectContent kind={kind} agent={agent} origin="table" />
      ) : (
        <div className="space-y-4">
          {isGone ? (
            <Alert variant="destructive">
              <AlertDescription>
                This {config.singularInSentence} is no longer available — it was
                deleted while you were editing it. Your unsaved changes cannot
                be saved; copy anything you need before leaving.
              </AlertDescription>
            </Alert>
          ) : (
            !canEdit &&
            !isAccessPending && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  You can view this {config.singularInSentence}&apos;s
                  configuration but not change it. {refusalReason}.
                </AlertDescription>
              </Alert>
            )
          )}

          {activeStep && (
            <AgentForm
              // A fresh mount per agent and per tab: the form seeds several
              // sets from per-agent reads and would otherwise carry one tab's
              // pending state into the next.
              key={`${agent.id}:${activeStep}`}
              agent={agent}
              agentType={formAgentType}
              defaultIconType={config.defaultIconType}
              sections={[activeStep]}
              readOnly={!canEdit}
              openToolsCombobox={openToolsCombobox}
              onDirtyChange={setIsDirty}
              footer={({
                isSaving,
                isDirty: formDirty,
                canSubmit,
                readOnly,
              }) =>
                // Nothing to save onto once the record is gone; the PUT would
                // only come back 404. A reader who cannot change it has no
                // save row at all — the alert above already says why.
                readOnly ? null : (
                  <WizardFooter className="sm:justify-end">
                    <Button
                      type="submit"
                      disabled={!canSubmit || isGone || isSaving || !formDirty}
                      data-testid={E2eTestId.AgentSetupSubmitButton}
                    >
                      {isSaving ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>Saving...</span>
                        </>
                      ) : (
                        <span>Save changes</span>
                      )}
                    </Button>
                  </WizardFooter>
                )
              }
            />
          )}
        </div>
      )}

      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={() => {
          pendingHrefRef.current = null;
          guard.keepEditing();
        }}
        onDiscard={guard.discardChanges}
      />
      <CloneAgentDialog
        agent={cloning ? agent : null}
        onOpenChange={(open) => {
          if (!open) setCloning(false);
        }}
        onCloned={(cloned) => {
          // Land on the clone's Configuration tab so it can be renamed
          // straight away.
          router.push(agentConfigureHref(kind, cloned.id, "configuration"));
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

const AGENT_DETAIL_TAB_LABELS: Record<AgentDetailTab, string> = {
  configuration: "Configuration",
  tools: "Tools & Knowledge",
  advanced: "Advanced",
  connect: "Connect",
  executions: "Executions",
};

function DetailPageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
