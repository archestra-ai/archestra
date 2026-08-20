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
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConvertToSkillDialog } from "@/app/agents/convert-to-skill-dialog";
import { AgentBadge } from "@/components/agent-badge";
import { AgentIcon } from "@/components/agent-icon";
import { AgentVersionHistoryDialog } from "@/components/agent-version-history-dialog";
import { CloneAgentDialog } from "@/components/clone-agent-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
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
  useDeleteProfile,
  useExportAgent,
  useProfile,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { AgentConnectContent } from "./agent-connect-content";
import { AgentOverview } from "./agent-overview";
import {
  AGENT_PAGE_CONFIGS,
  type AgentDetailTab,
  type AgentPageKind,
  agentDetailHref,
  agentEditHref,
  agentListHref,
  agentPageKindForType,
  isAgentTypeAllowedOnPage,
} from "./agent-page-config";
import { BackLink } from "./agent-page-shell";
import { useAgentAccess } from "./use-agent-access";

/**
 * `/<family>/[id]` — one agent-shaped resource's page: header with the
 * actions the list row used to offer, an Overview tab, and a Connect tab with
 * the "how do I use this?" instructions that used to open in a dialog.
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
    <BackLink href={agentListHref(kind)}>{config.plural}</BackLink>
  );

  if (isPending || (isLeavingAfterDelete && !agent)) {
    return (
      <PageLayout
        title={config.singular}
        description=""
        backLink={backLink}
        maxWidth="wizard"
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
  const { resource, canModify, canEdit, canCreate, canDelete, isBuiltIn } =
    useAgentAccess(agent, kind);
  // The record's own resource, not the route family's: a legacy profile shown
  // under the proxy pages is authorized as an `agent` everywhere, version
  // history included.
  const { data: canReadResource } = useHasPermissions({
    [resource]: ["read"],
  });
  const { data: canCreateSkill } = useHasPermissions({ skill: ["create"] });

  // Built-in agents are not connectable.
  const showConnectTab = !isBuiltIn;
  const tabParam = searchParams.get("tab");
  const tab: AgentDetailTab =
    tabParam === "connect" && showConnectTab ? "connect" : "overview";
  // A built-in agent has only the Overview: no tab strip for a single tab.
  const tabs = showConnectTab
    ? [
        { label: "Overview", href: agentDetailHref(kind, agent.id) },
        { label: "Connect", href: agentDetailHref(kind, agent.id, "connect") },
      ]
    : [];

  const [cloning, setCloning] = useState(false);
  const [converting, setConverting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteRequested, setDeleteRequested] = useState(false);
  const exportAgent = useExportAgent();
  const deleteAgent = useDeleteProfile();

  const canExport = kind === "agent" && !isBuiltIn;
  const canConvertToSkill = kind === "agent" && !isBuiltIn && !!canCreateSkill;
  const canClone = !isBuiltIn && canCreate;
  const showMoreMenu =
    canClone ||
    canExport ||
    canConvertToSkill ||
    !!canReadResource ||
    canDelete;

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
        </div>
      }
      documentTitle={agent.name}
      backLink={backLink}
      description={agent.description ?? ""}
      tabs={tabs}
      actionButton={
        <div className="flex shrink-0 items-center gap-2">
          {kind === "agent" && !isBuiltIn && (
            <Button variant="outline" asChild>
              <Link href={`/chat/new?agent_id=${agent.id}`}>
                <MessageSquare className="h-4 w-4" />
                Chat
              </Link>
            </Button>
          )}
          {canEdit && (
            <Button asChild data-testid={E2eTestId.AgentDetailEditButton}>
              <Link href={agentEditHref(kind, agent.id)}>
                <Pencil className="h-4 w-4" />
                Edit
              </Link>
            </Button>
          )}
          {showMoreMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">More actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canClone && (
                  <DropdownMenuItem onClick={() => setCloning(true)}>
                    <Copy className="h-4 w-4" />
                    Clone
                  </DropdownMenuItem>
                )}
                {canExport && (
                  <DropdownMenuItem
                    disabled={exportAgent.isPending}
                    onClick={handleExport}
                  >
                    <Download className="h-4 w-4" />
                    Export
                  </DropdownMenuItem>
                )}
                {canReadResource && (
                  <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                    <History className="h-4 w-4" />
                    Version history
                  </DropdownMenuItem>
                )}
                {canConvertToSkill && (
                  <DropdownMenuItem onClick={() => setConverting(true)}>
                    <Sparkles className="h-4 w-4" />
                    Convert to skill
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setDeleteRequested(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {tab === "overview" && <AgentOverview kind={kind} agent={agent} />}
        {tab === "connect" && (
          <div className="rounded-lg border bg-card p-6">
            <AgentConnectContent kind={kind} agent={agent} origin="table" />
          </div>
        )}
      </div>

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

function DetailPageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
