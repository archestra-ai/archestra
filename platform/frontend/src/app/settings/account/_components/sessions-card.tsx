"use client";

import { Laptop, Loader2, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { UAParser } from "ua-parser-js";
import { LoadingSkeletons } from "@/components/loading";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useSession } from "@/lib/auth/auth.query";
import {
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
  const { data: sessions, isPending } = useListSessions();
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
