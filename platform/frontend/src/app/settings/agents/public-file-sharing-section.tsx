"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { FileText, Film } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { QueryLoadError } from "@/components/query-load-error";
import { RelativeTime } from "@/components/relative-time";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  useOrganization,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";
import {
  type PublicFileLink,
  usePublicFileLinks,
  useRevokePublicFileLink,
} from "@/lib/public-file-links.query";

/**
 * The organization switch for `share_file_publicly`, and the list of every
 * public link agents created, so an admin can see what is public and revoke it.
 */
export function PublicFileSharingSection() {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateSecuritySettings(
    "Public file sharing updated",
    "Failed to update public file sharing",
  );
  const enabled = organization?.allowPublicFileSharing ?? false;

  return (
    <SettingsBlock
      id="public-file-sharing"
      title="Public File Sharing"
      description={
        <>
          Let agents publish images, videos, and PDFs as public links that
          anyone can open without logging in — to hand an image to a social
          media scheduler, for example. Turning this off stops every existing
          link.{" "}
          <ExternalDocsLink
            href={getDocsUrl(DocsPage.PlatformCodeSandbox, "public-links")}
            className="whitespace-nowrap"
          >
            Learn more
          </ExternalDocsLink>
        </>
      }
      control={
        <WithPermissions
          permissions={{ organizationSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <Switch
              aria-label="Allow agents to share files publicly"
              checked={enabled}
              disabled={
                !organization || !hasPermission || updateMutation.isPending
              }
              onCheckedChange={(checked) =>
                updateMutation.mutate({ allowPublicFileSharing: checked })
              }
            />
          )}
        </WithPermissions>
      }
    >
      <WithPermissions
        permissions={{ publicFileLink: ["read"] }}
        noPermissionHandle="hide"
      >
        <SharedFilesList />
      </WithPermissions>
    </SettingsBlock>
  );
}

// === internal components ===

function SharedFilesList() {
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  const { data, isLoadingError, refetch } = usePublicFileLinks({
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
    return (
      <p className="text-sm text-muted-foreground">
        No files have been shared publicly yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-lg border">
        {data.data.map((link) => (
          <SharedFileRow key={link.id} link={link} />
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

function SharedFileRow({ link }: { link: PublicFileLink }) {
  const revokeMutation = useRevokePublicFileLink();
  const revoked = link.revokedAt !== null;
  const sharedBy = [link.createdBy?.name, link.agent?.name]
    .filter(Boolean)
    .join(" via ");

  return (
    <li className="flex items-center gap-3 p-3">
      <Thumbnail link={link} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{link.filename}</span>
          {revoked && <Badge variant="secondary">Revoked</Badge>}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {sharedBy && <span className="truncate">{sharedBy} ·</span>}
          <RelativeTime date={link.createdAt} />
        </div>
      </div>
      {!revoked && (
        <div className="flex shrink-0 items-center gap-1">
          <CopyButton text={link.url} buttonSize="icon-sm" />
          <WithPermissions
            permissions={{ publicFileLink: ["delete"] }}
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
