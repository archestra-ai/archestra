"use client";

import type { archestraApiTypes } from "@shared";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfiles } from "@/lib/agent.query";
import { useInteractionSessions } from "@/lib/interaction.query";

import { DEFAULT_TABLE_LIMIT, formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../../_parts/error-boundary";

type SessionData =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number];

function SessionSourceBadge({
  sessionSource,
  sessionId,
}: {
  sessionSource: string | null;
  sessionId: string | null;
}) {
  if (!sessionId) {
    return (
      <Badge variant="outline" className="text-xs text-muted-foreground">
        Single
      </Badge>
    );
  }

  switch (sessionSource) {
    case "claude_code":
      return (
        <Badge
          variant="secondary"
          className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300"
        >
          Claude Code
        </Badge>
      );
    case "header":
      return (
        <Badge variant="secondary" className="text-xs">
          Custom
        </Badge>
      );
    case "openai_user":
      return (
        <Badge variant="secondary" className="text-xs">
          OpenAI User
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-xs">
          Session
        </Badge>
      );
  }
}

function Pagination({
  pageIndex,
  pageSize,
  total,
  onPaginationChange,
}: {
  pageIndex: number;
  pageSize: number;
  total: number;
  onPaginationChange: (params: { pageIndex: number; pageSize: number }) => void;
}) {
  const totalPages = Math.ceil(total / pageSize);
  const canPrevious = pageIndex > 0;
  const canNext = pageIndex < totalPages - 1;

  return (
    <div className="flex items-center justify-between px-2 py-4">
      <div className="text-sm text-muted-foreground">
        Showing {pageIndex * pageSize + 1} to{" "}
        {Math.min((pageIndex + 1) * pageSize, total)} of {total} results
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onPaginationChange({ pageIndex: pageIndex - 1, pageSize })
          }
          disabled={!canPrevious}
        >
          Previous
        </Button>
        <span className="text-sm">
          Page {pageIndex + 1} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onPaginationChange({ pageIndex: pageIndex + 1, pageSize })
          }
          disabled={!canNext}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  agents,
}: {
  session: SessionData;
  agents: archestraApiTypes.GetAllAgentsResponses["200"] | undefined;
}) {
  const router = useRouter();

  const agent = agents?.find((a) => a.id === session.profileId);
  const isSingleInteraction =
    session.sessionId === null && session.interactionId;

  // For single interactions (no session), navigate directly to interaction detail page
  // For sessions, navigate to session detail page
  const handleRowClick = () => {
    if (isSingleInteraction) {
      router.push(`/logs/${session.interactionId}`);
    } else if (session.sessionId) {
      router.push(`/logs/llm-proxy/session/${session.sessionId}`);
    }
  };

  // Format session ID for display (show first 8 chars of UUID)
  const displaySessionId = session.sessionId
    ? `${session.sessionId.slice(0, 8)}...`
    : "—";

  return (
    <TableRow className="cursor-pointer" onClick={handleRowClick}>
      <TableCell className="py-3">
        <SessionSourceBadge
          sessionSource={session.sessionSource}
          sessionId={session.sessionId}
        />
      </TableCell>
      <TableCell className="font-mono text-xs py-3">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{displaySessionId}</span>
            </TooltipTrigger>
            {session.sessionId && (
              <TooltipContent>
                <p className="font-mono text-xs">{session.sessionId}</p>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      </TableCell>
      <TableCell className="py-3">
        <TruncatedText
          message={agent?.name ?? session.profileName ?? "Unknown"}
          maxLength={25}
        />
      </TableCell>
      <TableCell className="font-mono text-xs py-3">
        {session.requestCount.toLocaleString()}
      </TableCell>
      <TableCell className="py-3">
        <div className="flex flex-wrap gap-1">
          {session.models.map((model) => (
            <Badge
              key={model}
              variant="secondary"
              className="text-xs whitespace-nowrap"
            >
              {model}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs py-3">
        {session.totalInputTokens.toLocaleString()} /{" "}
        {session.totalOutputTokens.toLocaleString()}
      </TableCell>
      <TableCell className="font-mono text-xs py-3">
        {formatDate({ date: session.firstRequest })}
      </TableCell>
      <TableCell className="font-mono text-xs py-3">
        {formatDate({ date: session.lastRequest })}
      </TableCell>
    </TableRow>
  );
}

export default function LlmProxyLogsPage({
  initialData,
}: {
  initialData?: {
    interactions: archestraApiTypes.GetInteractionsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
}) {
  return (
    <div>
      <ErrorBoundary>
        <SessionsTable initialData={initialData} />
      </ErrorBoundary>
    </div>
  );
}

function SessionsTable({
  initialData,
}: {
  initialData?: {
    interactions: archestraApiTypes.GetInteractionsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Get URL params
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const profileIdFromUrl = searchParams.get("profileId");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);

  const [profileFilter, setProfileFilter] = useState(profileIdFromUrl || "all");

  // Helper to update URL params
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === "" || value === "all") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      });
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      updateUrlParams({
        page: String(newPagination.pageIndex + 1),
        pageSize: String(newPagination.pageSize),
      });
    },
    [updateUrlParams],
  );

  const handleProfileFilterChange = useCallback(
    (value: string) => {
      setProfileFilter(value);
      updateUrlParams({
        profileId: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
    },
    [updateUrlParams],
  );

  const { data: sessionsResponse } = useInteractionSessions({
    limit: pageSize,
    offset: pageIndex * pageSize,
    profileId: profileFilter !== "all" ? profileFilter : undefined,
  });

  const { data: agents } = useProfiles({
    initialData: initialData?.agents,
  });

  const sessions = sessionsResponse?.data ?? [];
  const paginationMeta = sessionsResponse?.pagination;

  const hasFilters = profileFilter !== "all";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <SearchableSelect
          value={profileFilter}
          onValueChange={handleProfileFilterChange}
          placeholder="Filter by Profile"
          items={[
            { value: "all", label: "All Profiles" },
            ...(agents?.map((agent) => ({
              value: agent.id,
              label: agent.name,
            })) || []),
          ]}
          className="w-[200px]"
        />

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              handleProfileFilterChange("all");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {!sessions || sessions.length === 0 ? (
        <p className="text-muted-foreground">
          {hasFilters
            ? "No sessions match your filters. Try adjusting your search."
            : "No sessions found"}
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">Source</TableHead>
                <TableHead className="w-[100px]">Session ID</TableHead>
                <TableHead className="w-[150px]">Profile</TableHead>
                <TableHead className="w-[80px]">Requests</TableHead>
                <TableHead className="w-[200px]">Models</TableHead>
                <TableHead className="w-[140px]">Tokens (In/Out)</TableHead>
                <TableHead className="w-[160px]">First Request</TableHead>
                <TableHead className="w-[160px]">Last Request</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session, index) => (
                <SessionRow
                  key={`${session.sessionId ?? "single"}-${session.profileId}-${index}`}
                  session={session}
                  agents={agents}
                />
              ))}
            </TableBody>
          </Table>
          {paginationMeta && (
            <Pagination
              pageIndex={pageIndex}
              pageSize={pageSize}
              total={paginationMeta.total}
              onPaginationChange={handlePaginationChange}
            />
          )}
        </div>
      )}
    </div>
  );
}
