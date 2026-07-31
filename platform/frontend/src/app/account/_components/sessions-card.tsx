"use client";

import { KeyRound, Laptop, Loader2, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { UAParser } from "ua-parser-js";
import { LoadingSkeletons } from "@/components/loading";
import { QueryLoadError } from "@/components/query-load-error";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useSession } from "@/lib/auth/auth.query";
import {
  StaleSessionError,
  useListSessions,
  useRevokeSessionMutation,
} from "@/lib/auth/sessions.query";

/**
 * Lists the account's active sessions. Other sessions can be revoked in
 * place; revoking the current session signs the user out.
 */
export function SessionsCard() {
  const router = useRouter();
  const { data: session } = useSession();
  // isLoadingError, not isError: a failed background refetch keeps the last
  // good list on screen rather than replacing a working card with an error.
  const {
    data: sessions,
    isPending,
    isLoadingError,
    error,
    refetch,
  } = useListSessions();
  const revokeSession = useRevokeSessionMutation();

  return (
    <Card className="w-full">
      <SettingsCardHeader
        title="Sessions"
        description="Manage where your account is signed in."
      />
      <CardContent className="space-y-3">
        {isPending ? (
          <LoadingSkeletons rows={2} />
        ) : isLoadingError && error instanceof StaleSessionError ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRound />
              </EmptyMedia>
              <EmptyTitle>Sign in again to manage your sessions</EmptyTitle>
              <EmptyDescription>
                For your security, this list is only available shortly after you
                sign in. Sign out and back in to see where your account is
                signed in.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="outline"
                onClick={() => router.push("/auth/sign-out")}
              >
                Sign Out
              </Button>
            </EmptyContent>
          </Empty>
        ) : isLoadingError ? (
          <QueryLoadError
            className="py-6"
            title="Couldn't load your sessions"
            onRetry={() => refetch()}
          />
        ) : (
          (sessions ?? []).map((accountSession) => {
            const isCurrentSession = accountSession.id === session?.session?.id;
            const { deviceType, label } = describeUserAgent(
              accountSession.userAgent,
            );

            return (
              <div
                key={accountSession.id}
                className="flex items-center gap-3 rounded-md border p-3"
              >
                {deviceType === "mobile" ? (
                  <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {isCurrentSession
                      ? "Current session"
                      : (accountSession.ipAddress ?? "Unknown")}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {label}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revokeSession.isPending}
                  onClick={() => {
                    if (isCurrentSession) {
                      router.push("/auth/sign-out");
                      return;
                    }
                    revokeSession.mutate({ token: accountSession.token });
                  }}
                >
                  {revokeSession.isPending &&
                    revokeSession.variables?.token === accountSession.token && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                  {isCurrentSession ? "Sign Out" : "Revoke"}
                </Button>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function describeUserAgent(userAgent: string | null | undefined): {
  deviceType: "mobile" | "desktop";
  label: string;
} {
  if (!userAgent) {
    return { deviceType: "desktop", label: "Unknown device" };
  }

  const parsed = UAParser(userAgent);
  const parts = [parsed.os.name, parsed.browser.name].filter(Boolean);

  return {
    deviceType: parsed.device.type === "mobile" ? "mobile" : "desktop",
    label: parts.length > 0 ? parts.join(", ") : userAgent,
  };
}
