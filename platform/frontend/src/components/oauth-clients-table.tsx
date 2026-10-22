"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  Bot,
  Check,
  Network,
  Pencil,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Users,
  Workflow,
} from "lucide-react";
import { useEffect } from "react";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { EmptyState } from "@/components/empty-state";
import { LabelTags } from "@/components/label-tags";
import { TableRowActions } from "@/components/table-row-actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import { cn } from "@/lib/utils/tailwind";

export function OAuthClientsTable({
  clients,
  gateways,
  pagination,
  onPaginationChange,
  isLoading,
  hasActiveFilters,
  onClearFilters,
  onEdit,
  onRotate,
  onDelete,
}: OAuthClientsTableProps) {
  const { pageIndex, pageSize, total } = pagination;
  const lastPageIndex = Math.max(0, Math.ceil(total / pageSize) - 1);
  const targetsById = new Map(gateways.map((target) => [target.id, target]));

  useEffect(() => {
    if (!isLoading && pageIndex > lastPageIndex) {
      onPaginationChange({ pageIndex: lastPageIndex, pageSize });
    }
  }, [isLoading, lastPageIndex, onPaginationChange, pageIndex, pageSize]);

  return (
    <div className="@container min-w-0 w-full space-y-4">
      <div className="relative min-w-0 overflow-hidden rounded-md border">
        {isLoading && (
          <div
            role="progressbar"
            aria-label="Loading results"
            className="pointer-events-none absolute inset-x-px top-px z-10 h-[3px] overflow-hidden rounded-t-[5px] bg-primary/15 animate-in fade-in-0 duration-200 [animation-delay:150ms] [animation-fill-mode:backwards] motion-reduce:animate-none"
          >
            <div className="archestra-loading-sweep h-full rounded-full bg-primary" />
          </div>
        )}
        <Table
          role="table"
          aria-label="OAuth clients"
          aria-busy={isLoading}
          className="block @[700px]:table"
        >
          <colgroup className="hidden @[700px]:table-column-group">
            <col className="w-[32%]" />
            <col className="w-[21%]" />
            <col className="w-[18%]" />
            <col />
            <col className="w-[88px]" />
          </colgroup>
          <TableHeader
            role="rowgroup"
            className="hidden bg-muted/35 @[700px]:table-header-group"
          >
            <TableRow role="row" className="hover:bg-transparent">
              <TableHead
                role="columnheader"
                scope="col"
                className="px-3 text-xs text-muted-foreground md:px-3"
              >
                Application
              </TableHead>
              {CAPABILITIES.map(({ scope, label, icon: Icon }) => (
                <TableHead
                  key={scope}
                  role="columnheader"
                  scope="col"
                  className="border-l border-border/60 px-3 text-xs md:px-3"
                >
                  <span className="flex items-center gap-1.5">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span>{label}</span>
                  </span>
                </TableHead>
              ))}
              <TableHead
                role="columnheader"
                scope="col"
                className="px-3 text-xs text-muted-foreground md:px-3"
              >
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody
            role="rowgroup"
            className={cn(
              "block transition-opacity duration-200 motion-reduce:transition-none @[700px]:table-row-group",
              isLoading && "opacity-60 delay-150",
            )}
          >
            {clients.map((client) => {
              const userSignIn = client.grantType === "authorization_code";
              const SignInIcon = userSignIn ? Users : Server;
              const capabilities = getCapabilities({
                client,
                targetsById,
              });

              return (
                <TableRow
                  key={client.id}
                  role="row"
                  tabIndex={0}
                  onClick={() => onEdit(client)}
                  onKeyDown={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      onEdit(client);
                    }
                  }}
                  className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 px-3 py-3 outline-none focus-visible:bg-muted/60 @[700px]:table-row @[700px]:p-0 @[700px]:[&>td]:px-3 @[700px]:[&>td]:py-3"
                >
                  <TableCell
                    role="cell"
                    className="col-start-1 row-start-1 block min-w-0 px-0 py-0 md:px-0 @[700px]:table-cell"
                  >
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex min-w-0 items-start gap-2">
                        <span className="min-w-0 text-sm font-medium leading-5 [overflow-wrap:anywhere]">
                          {client.name}
                        </span>
                        <LabelTags labels={client.labels} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <SignInIcon className="size-3 shrink-0" />
                          <span>
                            {userSignIn ? "For its users" : "As itself"}
                          </span>
                        </span>
                        {client.disabled && (
                          <span className="border-l pl-2">Disabled</span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  {CAPABILITIES.map(({ scope, label, icon: Icon }, index) => (
                    <TableCell
                      key={scope}
                      role="cell"
                      className={cn(
                        "col-span-2 block min-w-0 px-0 py-0 md:px-0 @[700px]:table-cell @[700px]:border-l @[700px]:border-border/60",
                        index === 0 &&
                          "border-t border-border/60 pt-3 @[700px]:border-t-0",
                      )}
                    >
                      <div className="grid min-w-0 grid-cols-[104px_minmax(0,1fr)] items-start gap-x-3 @[700px]:block">
                        <span className="flex items-center gap-1.5 text-xs leading-4 text-muted-foreground @[700px]:hidden">
                          <Icon className="size-3.5 shrink-0" />
                          <span>{label}</span>
                        </span>
                        <Capability
                          enabled={client.scopes.includes(scope)}
                          {...capabilities[scope]}
                        />
                      </div>
                    </TableCell>
                  ))}
                  <TableCell
                    role="cell"
                    className="col-start-2 row-start-1 block px-0 py-0 md:px-0 @[700px]:table-cell"
                  >
                    <TableRowActions
                      itemName={client.name}
                      permissionScope={client.id}
                      actions={[
                        {
                          icon: <Pencil className="size-4" />,
                          label: "Edit",
                          permissions: { oauthClient: ["update"] },
                          onClick: () => onEdit(client),
                        },
                      ]}
                      dropdownActions={[
                        {
                          icon: <RefreshCw className="size-4" />,
                          label: "Rotate secret",
                          permissions: { oauthClient: ["update"] },
                          onClick: () => onRotate(client),
                        },
                        {
                          icon: <Trash2 className="size-4" />,
                          label: "Delete",
                          permissions: { oauthClient: ["delete"] },
                          variant: "destructive",
                          onClick: () => onDelete(client),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
            {clients.length === 0 && (
              <TableRow
                role="row"
                className="block hover:bg-transparent @[700px]:table-row"
              >
                <TableCell
                  role="cell"
                  colSpan={5}
                  className="block py-0 @[700px]:table-cell"
                >
                  <div className="min-h-[164px]">
                    {!isLoading && (
                      <EmptyState
                        icon={hasActiveFilters ? Search : undefined}
                        title={
                          hasActiveFilters
                            ? "No OAuth clients match your filters. Try adjusting your search."
                            : "No OAuth clients yet. Register one for an application that authenticates with OAuth."
                        }
                        onClearFilters={
                          hasActiveFilters ? onClearFilters : undefined
                        }
                      />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {/* Switch the shared pagination's layouts at the same container width. */}
      <div className="[&>div:first-child]:hidden [&>div:last-child]:flex @[700px]:[&>div:first-child]:flex @[700px]:[&>div:last-child]:hidden">
        <TablePagination
          pageIndex={pageIndex}
          pageSize={pageSize}
          total={total}
          onPaginationChange={onPaginationChange}
        />
      </div>
    </div>
  );
}

type Client = archestraApiTypes.GetOauthClientsResponses["200"]["data"][number];

type OAuthClientsTableProps = {
  clients: Client[];
  gateways: AgentSelectorAgent[];
  pagination: { pageIndex: number; pageSize: number; total: number };
  onPaginationChange: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
  isLoading: boolean;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  onEdit: (client: Client) => void;
  onRotate: (client: Client) => void;
  onDelete: (client: Client) => void;
};

type CapabilityDetails = { summary: string; details: string[] };

function Capability({
  enabled,
  summary,
  details,
}: CapabilityDetails & { enabled: boolean }) {
  if (!enabled) {
    return (
      <span className="text-muted-foreground/50">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not enabled</span>
      </span>
    );
  }

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-start gap-1.5 text-xs font-medium leading-4">
        <Check className="mt-0.5 size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="min-w-0 tabular-nums [overflow-wrap:anywhere]">
          {summary}
        </span>
      </div>
      <div className="space-y-0.5 pl-[18px] text-xs leading-4 text-muted-foreground">
        {Array.from(new Set(details)).map((detail) => (
          <div key={detail} className="[overflow-wrap:anywhere]">
            {detail}
          </div>
        ))}
      </div>
    </div>
  );
}

function getCapabilities({
  client,
  targetsById,
}: {
  client: Client;
  targetsById: Map<string, AgentSelectorAgent>;
}): Record<"mcp" | "a2a" | "llm:proxy", CapabilityDetails> {
  const userSignIn = client.grantType === "authorization_code";
  const targets = client.allowedGatewayIds.map((id) => targetsById.get(id));
  const agents = targets.filter(
    (target): target is AgentSelectorAgent => target?.agentType === "agent",
  );
  const unresolved = targets.filter((target) => !target).length;
  const targetNames = targets.flatMap((target) =>
    target ? [target.name] : [],
  );
  const agentNames = agents.map((agent) => agent.name);
  const unresolvedDetails = unresolved
    ? [`${countLabel(unresolved, "target")} with unavailable details`]
    : [];

  return {
    mcp: {
      summary: userSignIn
        ? "Each user's access"
        : countLabel(targets.length, "target"),
      details: userSignIn
        ? targets.length > 0
          ? [
              countLabel(targets.length, "additional target"),
              ...targetNames,
              ...unresolvedDetails,
            ]
          : ["Gateways & tools"]
        : targets.length > 0
          ? [...targetNames, ...unresolvedDetails]
          : ["None selected"],
    },
    a2a: {
      summary: userSignIn
        ? "Each user's access"
        : unresolved > 0
          ? agents.length > 0
            ? countLabel(agents.length, "known agent")
            : "Configured"
          : countLabel(agents.length, "agent"),
      details: userSignIn
        ? [
            ...(agents.length > 0
              ? [countLabel(agents.length, "additional agent"), ...agentNames]
              : ["Callable agents"]),
            ...unresolvedDetails,
          ]
        : agents.length > 0 || unresolved > 0
          ? [...agentNames, ...unresolvedDetails]
          : ["None selected"],
    },
    "llm:proxy": {
      summary: userSignIn
        ? "Each user's access"
        : client.includeFutureProviders
          ? "Current & future"
          : countLabel(client.providerApiKeys.length, "key"),
      details: userSignIn
        ? ["Own keys & limits"]
        : client.includeFutureProviders
          ? [
              "Shared Primary keys",
              ...(client.providerApiKeys.length
                ? [countLabel(client.providerApiKeys.length, "override")]
                : []),
            ]
          : client.providerApiKeys.length > 0
            ? client.providerApiKeys.map(
                (key) => key.providerApiKeyName || key.provider,
              )
            : ["None selected"],
    },
  };
}

function countLabel(count: number, label: string) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

const CAPABILITIES = [
  { scope: "mcp", label: "MCP Gateway", icon: Network },
  { scope: "a2a", label: "A2A", icon: Workflow },
  { scope: "llm:proxy", label: "LLM Proxy", icon: Bot },
] as const;
