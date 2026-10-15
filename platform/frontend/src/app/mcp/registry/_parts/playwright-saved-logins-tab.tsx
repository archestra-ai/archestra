"use client";

import { Cookie } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type SavedBrowserLogin,
  useSavedBrowserLogins,
  useSignOutBrowserLogin,
} from "@/lib/browser-storage-state.query";
import { formatBytes } from "@/lib/skills-sandbox/sandbox-file-preview";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

/**
 * Admin view of the Playwright browser logins saved per user. Each user's
 * cookies and localStorage are restored into every chat they start; signing
 * them out deletes that saved state.
 */
export function PlaywrightSavedLoginsTab() {
  const {
    data: logins,
    isPending,
    isError,
    refetch,
  } = useSavedBrowserLogins({ enabled: true });
  const signOut = useSignOutBrowserLogin();
  const [pending, setPending] = useState<SavedBrowserLogin | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Each user's cookies are saved and reused in all their chats. Never
        shared between users.
      </p>

      {isPending && <Skeleton className="h-32 w-full" />}

      {isError && (
        <QueryLoadError
          title="Couldn't load saved logins"
          onRetry={() => refetch()}
          className=""
        />
      )}

      {logins && logins.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
          <Cookie className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">No saved logins yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            A user's logins are saved the first time they sign in to a site in a
            chat's browser.
          </p>
        </div>
      )}

      {logins && logins.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Sites</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Last saved</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logins.map((login) => (
                <TableRow key={login.userId}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-7 w-7">
                        {login.image && (
                          <AvatarImage src={login.image} alt="" />
                        )}
                        <AvatarFallback className="text-xs">
                          {login.name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{login.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {login.email}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {login.siteCount} {login.siteCount === 1 ? "site" : "sites"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatBytes(login.sizeBytes)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatRelativeTimeFromNow(login.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setPending(login)}
                    >
                      Sign out
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Sign out deletes the user's saved cookies. Chats already open keep their
        current browser until it closes.
      </p>

      <DeleteConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title="Sign out of the browser?"
        description={`${pending?.name ?? "This user"} will be signed out of every site in new chats.`}
        confirmLabel="Sign out"
        pendingLabel="Signing out..."
        isPending={signOut.isPending}
        onConfirm={() => {
          if (!pending) return;
          signOut.mutate(pending.userId, {
            onSuccess: () => setPending(null),
          });
        }}
      />
    </div>
  );
}
