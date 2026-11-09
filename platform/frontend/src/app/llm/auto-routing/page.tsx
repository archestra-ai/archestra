"use client";

import { DocsPage } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Route, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FilterBar, filterSearchClass } from "@/components/filter-bar";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { DataTable } from "@/components/ui/data-table";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  type AutoRouter,
  useAutoRouters,
  useDeleteAutoRouter,
} from "@/lib/auto-routing.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useLlmModels } from "@/lib/llm-models.query";
import { formatCurrency } from "@/lib/utils/format-currency";
import { BUDGET_PRESET_LABELS } from "./_parts/budget-presets";
import { ConfigureAutoRoutingDialog } from "./_parts/configure-dialog";
import { RouterStatus, routerStatus } from "./_parts/router-status";
import { TIER_NAMES } from "./_parts/tiers";

const EMPTY_MESSAGE =
  "No auto routers yet. Create one to send each session to a fast, normal or smart model.";

/** The organization's auto routers, each a model name of its own. */
export default function AutoRoutersPage() {
  const query = useAutoRouters();
  const routers = query.data ?? [];
  const navigation = useRouter();
  const { searchParams } = useDataTableQueryParams();
  const search = (searchParams.get("search") ?? "").trim().toLowerCase();
  const { data: models = [] } = useLlmModels();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AutoRouter | null>(null);
  const [deleting, setDeleting] = useState<AutoRouter | null>(null);
  const deleteRouter = useDeleteAutoRouter();

  const visible = routers.filter(
    (router) => !search || router.name.toLowerCase().includes(search),
  );
  const editingRouter = editing
    ? (routers.find((router) => router.id === editing.id) ?? editing)
    : null;
  const open = (router: AutoRouter) =>
    navigation.push(`/llm/auto-routing/${router.id}`);
  const modelName = (tier: AutoRouter["tiers"]["fast"]) =>
    tier
      ? (models.find((model) => model.dbId === tier.id)?.displayName ??
        tier.modelId)
      : "Not set";

  const columns: ColumnDef<AutoRouter>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      size: 220,
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate font-mono font-medium">
            {row.original.name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {usage(row.original)}
          </div>
        </div>
      ),
    },
    {
      id: "models",
      header: "Fast / normal / smart",
      size: 320,
      cell: ({ row }) => (
        <span className="block truncate text-sm">
          {TIER_NAMES.map((tier) => modelName(row.original.tiers[tier])).join(
            " / ",
          )}
        </span>
      ),
    },
    {
      id: "budget",
      header: "Daily budget",
      size: 140,
      cell: ({ row }) => (
        <span className="text-sm">{budget(row.original)}</span>
      ),
    },
    {
      id: "plan",
      header: "Plan",
      size: 170,
      cell: ({ row }) => (
        <span className="text-sm">{planState(row.original)}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      size: 130,
      cell: ({ row }) => <RouterStatus label={routerStatus(row.original)} />,
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <TableRowActions
          itemName={row.original.name}
          actions={[
            {
              icon: <Pencil className="h-4 w-4" />,
              label: "Edit",
              permissions: { llmProxy: ["update"] },
              onClick: () => setEditing(row.original),
            },
          ]}
          dropdownActions={[
            {
              icon: <Trash2 className="h-4 w-4" />,
              label: "Delete",
              permissions: { llmProxy: ["update"] },
              variant: "destructive",
              onClick: () => setDeleting(row.original),
            },
          ]}
        />
      ),
    },
  ];

  const organizationOff = routers.length > 0 && !routers[0].enabled;

  return (
    <PageLayout
      minWidth="phone"
      title="Auto Routing"
      description={
        <>
          <span>
            An auto router is a model name that sends each session to a fast,
            normal or smart model within a daily budget. Pick one for an agent
            or a chat, or add it to a virtual key.
          </span>{" "}
          <ExternalDocsLink
            href={getFrontendDocsUrl(DocsPage.PlatformLlmProxyAutoRouting)}
            showIcon={false}
          >
            Read more in the docs
          </ExternalDocsLink>
        </>
      }
      actionButton={
        <PermissionButton
          size="sm"
          permissions={{ llmProxy: ["update"] }}
          onClick={() => setCreating(true)}
        >
          <Plus />
          <span>Create auto router</span>
        </PermissionButton>
      }
    >
      {query.isLoadingError ? (
        <QueryLoadError
          title="Couldn't load your auto routers"
          error={query.error}
          onRetry={() => query.refetch()}
        />
      ) : (
        <div className="space-y-4">
          {organizationOff && (
            <InlineNotice variant="neutral">
              <span className="font-medium">Auto routing is off</span>
              <InlineNoticeText>
                No router is offered or answers requests until it is turned on
                in{" "}
                <Link href="/settings/llm" className="underline">
                  Settings
                </Link>
                .
              </InlineNoticeText>
            </InlineNotice>
          )}
          <FilterBar
            search={
              <SearchInput
                objectNamePlural="auto routers"
                searchFields={["name"]}
                paramName="search"
                className={filterSearchClass}
              />
            }
          />
          <DataTable
            columns={columns}
            flexibleColumnIds={["models"]}
            fixedWidthColumnIds={["budget", "plan", "status"]}
            columnDropOrder={["plan", "budget"]}
            data={visible}
            getRowId={(row) => row.id}
            onRowClick={open}
            isLoading={query.isLoading}
            hasActiveFilters={Boolean(search)}
            emptyIcon={Route}
            emptyMessage={EMPTY_MESSAGE}
            filteredEmptyMessage="No auto routers match your search."
          />
        </div>
      )}

      {creating ? (
        <ConfigureAutoRoutingDialog
          router={null}
          existingNames={routers.map((router) => router.name)}
          onOpenChange={(next) => {
            if (!next) setCreating(false);
          }}
        />
      ) : null}
      {editingRouter ? (
        <ConfigureAutoRoutingDialog
          key={editingRouter.id}
          router={editingRouter}
          existingNames={routers
            .filter((router) => router.id !== editingRouter.id)
            .map((router) => router.name)}
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
        />
      ) : null}
      <DeleteConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title="Delete auto router"
        description={`Delete "${deleting?.name}"? Its plans and what it learned go with it. Agents and chats on it go back to their own model, and requests for this name are refused.`}
        confirmLabel="Delete"
        isPending={deleteRouter.isPending}
        onConfirm={() => {
          if (!deleting) return;
          deleteRouter.mutate(deleting.id, {
            onSuccess: () => setDeleting(null),
          });
        }}
      />
    </PageLayout>
  );
}

/** Who runs on the router, in a few words. */
function usage(router: AutoRouter): string {
  const keys = router.virtualApiKeyIds.length;
  const agents = router.usage.agentCount;
  const parts = [
    router.usage.organizationDefault ? "Organization default" : null,
    agents > 0 ? `${agents} ${agents === 1 ? "agent" : "agents"}` : null,
    keys > 0 ? `${keys} ${keys === 1 ? "virtual key" : "virtual keys"}` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "Not used yet";
}

function budget(router: AutoRouter): string {
  if (router.budgetPreset) return BUDGET_PRESET_LABELS[router.budgetPreset];
  return router.budgetUsdPerDay === null
    ? "Not set"
    : `${formatCurrency(router.budgetUsdPerDay)}/day`;
}

function planState(router: AutoRouter): string {
  const { activePlan, coldStart } = router.status;
  if (activePlan) return "Active plan";
  if (coldStart.sessions < coldStart.required) {
    return `Cold start · ${coldStart.sessions} of ${coldStart.required}`;
  }
  return "No plan yet";
}
