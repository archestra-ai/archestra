"use client";

import { FileText, Film } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { QueryLoadError } from "@/components/query-load-error";
import { RelativeTime } from "@/components/relative-time";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  type PublicFileLink,
  type PublicFileLinkScope,
  usePublicFileLinks,
  useRevokePublicFileLink,
} from "@/lib/public-file-links.query";

/**
 * Public links agents created with `share_file_publicly`: a thumbnail, who
 * shared it through which agent, a copy button, and Revoke. `mine` lists the
 * viewer's own links (revoking needs publicFileLink:delete); `organization`
 * lists everyone's (revoking needs publicFileLink:admin).
 */
export function PublicFileLinksList({
  scope,
  emptyText,
}: {
  scope: PublicFileLinkScope;
  emptyText: string;
}) {
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  const { data, isLoadingError, refetch } = usePublicFileLinks({
    scope,
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
  });

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load shared files"
        onRetry={() => refetch()}
      />
    );
  }
  if (!data) return null;
  if (data.pagination.total === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-lg border">
        {data.data.map((link) => (
          <PublicFileLinkRow key={link.id} link={link} scope={scope} />
        ))}
      </ul>
      {data.pagination.total > pagination.pageSize && (
        <TablePagination
          pageIndex={pagination.pageIndex}
          pageSize={pagination.pageSize}
          total={data.pagination.total}
          onPaginationChange={setPagination}
          compact
        />
      )}
    </div>
  );
}

// === internal components ===

function PublicFileLinkRow({
  link,
  scope,
}: {
  link: PublicFileLink;
  scope: PublicFileLinkScope;
}) {
  const revokeMutation = useRevokePublicFileLink();
  const revoked = link.revokedAt !== null;
  // In your own list, "you" goes without saying; the agent still helps.
  const sharedBy =
    scope === "mine"
      ? link.agent
        ? `via ${link.agent.name}`
        : ""
      : [link.createdBy?.name, link.agent?.name].filter(Boolean).join(" via ");

  return (
    <li className="flex items-center gap-3 p-3">
      <Thumbnail link={link} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{link.filename}</span>
          {revoked && <Badge variant="secondary">Revoked</Badge>}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {sharedBy ? <span className="truncate">{sharedBy} ·</span> : null}
          <RelativeTime date={link.createdAt} />
        </div>
      </div>
      {!revoked && (
        <div className="flex shrink-0 items-center gap-1">
          <CopyButton text={link.url} buttonSize="icon-sm" />
          <WithPermissions
            permissions={{
              publicFileLink: [scope === "mine" ? "delete" : "admin"],
            }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!hasPermission || revokeMutation.isPending}
                onClick={() => revokeMutation.mutate(link.id)}
              >
                Revoke
              </Button>
            )}
          </WithPermissions>
        </div>
      )}
    </li>
  );
}

function Thumbnail({ link }: { link: PublicFileLink }) {
  const box =
    "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted";
  if (link.revokedAt === null && link.mimeType.startsWith("image/")) {
    return (
      <div className={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={link.url}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      </div>
    );
  }
  const Icon = link.mimeType.startsWith("video/") ? Film : FileText;
  return (
    <div className={box}>
      <Icon className="size-4 text-muted-foreground" />
    </div>
  );
}
