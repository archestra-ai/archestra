"use client";

import { ArrowLeft, CircleAlert, CircleCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { LoadingState } from "@/components/loading";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { useCompleteGitHubUserConnection } from "@/lib/runtime-credentials.query";

export default function GitHubConnectionCallback() {
  const router = useRouter();
  const started = useRef(false);
  const complete = useCompleteGitHubUserConnection();
  useEffect(() => {
    let active = true;
    // Start after the effect settles so Strict Mode's setup/cleanup replay
    // cannot detach the mutation observer while the request is in flight.
    queueMicrotask(() => {
      if (!active || started.current) return;
      started.current = true;
      const query = new URLSearchParams(window.location.search);
      const code = query.get("code");
      const state = query.get("state");
      window.history.replaceState(null, "", window.location.pathname);
      if (!code || !state) return;
      complete.mutate(
        { code, state },
        { onSuccess: () => router.replace("/settings/credentials") },
      );
    });
    return () => {
      active = false;
    };
  }, [complete, router]);

  const pending = complete.isPending;
  const success = complete.isSuccess;
  const title = pending
    ? "Connecting GitHub"
    : success
      ? "GitHub is connected"
      : "Let’s reconnect GitHub";
  const description = pending
    ? "Finishing sign-in and saving your connection. This usually takes a few seconds."
    : success
      ? "Your account is ready to use across your agents. Taking you back to credentials…"
      : "This sign-in couldn’t be completed. Return to credentials and connect GitHub again.";

  return (
    <div className="flex min-h-[360px] items-center justify-center px-4 py-10 sm:py-16">
      <Card className="w-full max-w-md gap-0 overflow-hidden py-0 shadow-none">
        <CardContent className="px-7 pb-7 pt-8 sm:px-8">
          <div className="mb-7 flex size-12 items-center justify-center rounded-xl border bg-background">
            <RuntimeCredentialIcon icon="logo:github" className="size-6" />
          </div>
          <div aria-live="polite" aria-atomic="true">
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {description}
            </p>
            <div className="mt-6 flex items-center gap-2.5 text-sm">
              {pending ? (
                <LoadingState
                  variant="inline"
                  label="Saving GitHub connection"
                />
              ) : success ? (
                <CircleCheck
                  className="size-4 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              ) : (
                <CircleAlert
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <span>
                {pending
                  ? "Saving your connection"
                  : success
                    ? "Connected successfully"
                    : "A fresh sign-in is needed"}
              </span>
            </div>
            {!pending && !success && (
              <Button
                className="mt-6 w-full"
                onClick={() => router.replace("/settings/credentials")}
              >
                <ArrowLeft aria-hidden="true" />
                <span>Back to credentials</span>
              </Button>
            )}
          </div>
        </CardContent>
        <CardFooter className="border-t bg-muted/30 px-7 py-4 sm:px-8">
          <p className="text-xs leading-5 text-muted-foreground">
            One GitHub connection, shared across your agents.
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
