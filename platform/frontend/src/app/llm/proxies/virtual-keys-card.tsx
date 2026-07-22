"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound, Plus } from "lucide-react";
import Link from "next/link";
import { formatProviderKeySummary } from "@/components/provider-key-mappings-field";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";

type VirtualKeyRow =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];

const PREVIEW_LIMIT = 5;

/**
 * Compact Virtual API Keys view for the LLM Proxy workspace. Lists the same
 * records as Client Credentials — keys are global, never assigned to a proxy —
 * so all management deep-links go there.
 */
export function VirtualKeysCard() {
  const { data: canReadKeys, isPending: permissionPending } = useHasPermissions(
    { llmVirtualKey: ["read"] },
  );
  const { data: keysResponse, isPending } = useAllVirtualApiKeys({
    limit: PREVIEW_LIMIT,
    toastOnError: false,
    enabled: canReadKeys === true,
  });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const keys = keysResponse?.data ?? [];
  const total = keysResponse?.pagination.total ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Virtual API Keys</CardTitle>
            <CardDescription className="mt-1">
              Client credentials for this proxy's endpoints.
            </CardDescription>
          </div>
          {canReadKeys && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/credentials/virtual-keys?create=true">
                <Plus className="h-4 w-4" />
                Create key
              </Link>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {permissionPending || (canReadKeys && isPending) ? (
          <div className="space-y-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : !canReadKeys ? (
          <p className="text-sm text-muted-foreground">
            You don't have permission to view Virtual API Keys.
          </p>
        ) : keys.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <KeyRound className="mx-auto h-6 w-6 text-muted-foreground" />
              <EmptyTitle className="text-sm">
                No Virtual API Keys yet
              </EmptyTitle>
              <EmptyDescription>
                Keys map client requests to your stored provider credentials, so
                clients never hold real provider secrets. Connect also creates a
                personal key automatically when setting up a client.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" asChild>
                <Link href="/credentials/virtual-keys?create=true">
                  <Plus className="h-4 w-4" />
                  Create key
                </Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <p className="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Virtual API Keys are global — any key you can access works on any
              compatible proxy. This list manages the same records as Client
              Credentials.
            </p>
            <ul className="divide-y">
              {keys.map((key) => (
                <VirtualKeyRowItem
                  key={key.id}
                  virtualKey={key}
                  currentUserId={currentUserId}
                />
              ))}
            </ul>
            <div className="mt-3 border-t pt-3 text-sm">
              <Link
                href="/credentials/virtual-keys"
                className="text-primary hover:underline"
              >
                {total > keys.length
                  ? `All ${total} keys and OAuth clients → Client Credentials`
                  : "All keys and OAuth clients → Client Credentials"}
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function VirtualKeyRowItem({
  virtualKey,
  currentUserId,
}: {
  virtualKey: VirtualKeyRow;
  currentUserId: string | undefined;
}) {
  const isPassthrough = virtualKey.keyType === "passthrough";
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {virtualKey.name}
          </span>
          {isPassthrough && (
            <Badge variant="outline" className="text-xs font-normal">
              Passthrough
            </Badge>
          )}
        </div>
        <code className="text-xs text-muted-foreground">
          {virtualKey.tokenStart}...
        </code>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {isPassthrough
            ? "Attribution only"
            : formatProviderKeySummary(virtualKey.providerApiKeys)}
        </span>
        <ResourceVisibilityBadge
          scope={virtualKey.scope as "personal" | "team" | "org" | undefined}
          teams={virtualKey.teams}
          authorId={virtualKey.authorId}
          authorName={virtualKey.authorName}
          currentUserId={currentUserId}
          showSelfAsMe
        />
        <ExpiryLabel expiresAt={virtualKey.expiresAt} />
      </div>
    </li>
  );
}

function ExpiryLabel({ expiresAt }: { expiresAt: string | null | undefined }) {
  if (!expiresAt) {
    return <span className="text-green-600 dark:text-green-500">Active</span>;
  }
  const expiry = new Date(expiresAt);
  if (expiry < new Date()) {
    return <span className="text-destructive">Expired</span>;
  }
  return <span>Expires {expiry.toLocaleDateString()}</span>;
}
