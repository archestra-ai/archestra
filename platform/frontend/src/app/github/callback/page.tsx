"use client";

import { ArrowLeft, CircleAlert, CircleCheck, Github } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AuthCallbackLayout } from "@/components/auth-callback-layout";
import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { consumeGitHubConnectionReturn } from "@/lib/github-connection-return";
import { useCompleteGitHubUserConnection } from "@/lib/runtime-credentials.query";

export default function GitHubConnectionCallback() {
  const router = useRouter();
  const started = useRef(false);
  const [initialized, setInitialized] = useState(false);
  const [returnTo, setReturnTo] = useState("/account/connections");
  const returnLabel = returnTo.startsWith("/agents/")
    ? "your agent"
    : returnTo.startsWith("/settings/credentials")
      ? "credentials"
      : returnTo.startsWith("/chat")
        ? "chat"
        : "connections";
  const complete = useCompleteGitHubUserConnection();
  useEffect(() => {
    let active = true;
    // Wait for Strict Mode's effect replay before starting the token exchange.
    queueMicrotask(() => {
      if (!active || started.current) return;
      started.current = true;
      const query = new URLSearchParams(window.location.search);
      const code = query.get("code");
      const state = query.get("state");
      const destination = consumeGitHubConnectionReturn(state);
      setReturnTo(destination);
      setInitialized(true);
      window.history.replaceState(null, "", window.location.pathname);
      if (!code || !state || query.has("error")) return;
      complete.mutate(
        { code, state },
        { onSuccess: () => router.replace(destination) },
      );
    });
    return () => {
      active = false;
    };
  }, [complete, router]);

  const pending = !initialized || complete.isPending;
  const success = complete.isSuccess;
  const title = pending
    ? "Connecting GitHub"
    : success
      ? "GitHub is connected"
      : "Let’s reconnect GitHub";

  return (
    <AuthCallbackLayout>
      <Card className="w-full max-w-md" aria-live="polite" aria-atomic="true">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/30">
            <Github className="size-6" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription>
            {pending
              ? "Finishing sign-in for your GitHub account."
              : success
                ? `Taking you back to ${returnLabel}…`
                : "This sign-in couldn’t be completed. Your existing connection has not changed."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 rounded-md border bg-muted/50 p-4">
            {pending ? (
              <LoadingState variant="inline" label="Saving GitHub connection" />
            ) : success ? (
              <CircleCheck
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            ) : (
              <CircleAlert
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <div>
              <p className="text-sm font-medium">
                {pending
                  ? "Saving your connection"
                  : success
                    ? "Connected successfully"
                    : "A fresh sign-in is needed"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {pending
                  ? "This usually takes only a few seconds."
                  : success
                    ? "Your GitHub account is ready to use."
                    : "Return and connect GitHub again."}
              </p>
            </div>
          </div>
          {pending && (
            <p className="text-center text-xs leading-5 text-muted-foreground">
              Keep this page open. You’ll return to {returnLabel} automatically.
            </p>
          )}
        </CardContent>
        {!pending && !success && (
          <CardFooter>
            <Button className="w-full" onClick={() => router.replace(returnTo)}>
              <ArrowLeft aria-hidden="true" />
              <span>Back to {returnLabel}</span>
            </Button>
          </CardFooter>
        )}
      </Card>
    </AuthCallbackLayout>
  );
}
