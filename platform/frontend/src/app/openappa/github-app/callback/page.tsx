"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AuthCallbackLayout } from "@/components/auth-callback-layout";
import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCompleteAppaGithubApp } from "@/lib/openappa-github-sync.query";
import { notifyGithubAppSetup } from "../../_parts/github-app-channel";

/**
 * Where GitHub returns the setup window after creating or installing the
 * OpenAPPA GitHub App. It reports back to the setup dialog and closes itself.
 */
export default function OpenAppaGithubAppCallback() {
  const started = useRef(false);
  const complete = useCompleteAppaGithubApp();
  const [step, setStep] = useState<"created" | "installed" | "invalid" | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    // Wait for Strict Mode's effect replay before using the one-time code.
    queueMicrotask(() => {
      if (!active || started.current) return;
      started.current = true;
      const query = new URLSearchParams(window.location.search);
      window.history.replaceState(null, "", window.location.pathname);
      const code = query.get("code");
      const state = query.get("state");
      if (code && state) {
        setStep("created");
        complete.mutate(
          { code, state },
          { onSuccess: () => finish("created") },
        );
      } else if (query.get("installation_id")) {
        setStep("installed");
        finish("installed");
      } else setStep("invalid");
    });
    return () => {
      active = false;
    };
  }, [complete]);

  const pending = step === null || (step === "created" && complete.isPending);
  const failed = step === "invalid" || complete.isError;
  const title = pending
    ? "Finishing GitHub App setup"
    : failed
      ? "GitHub App setup didn't finish"
      : step === "created"
        ? "GitHub App created"
        : "GitHub App installed";
  return (
    <AuthCallbackLayout>
      <Card className="w-full max-w-md" aria-live="polite" aria-atomic="true">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted/30">
            {pending ? (
              <LoadingState variant="inline" label="Saving the GitHub App" />
            ) : failed ? (
              <CircleAlert className="size-6" strokeWidth={1.5} aria-hidden />
            ) : (
              <CircleCheck className="size-6" strokeWidth={1.5} aria-hidden />
            )}
          </div>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription>
            {pending
              ? "This takes a few seconds."
              : failed
                ? (complete.error?.message ??
                  "GitHub didn't send what setup needs. Start again from the Archestra tab.")
                : "Return to the Archestra tab to continue. You can close this one."}
          </CardDescription>
        </CardHeader>
        {!pending && (
          <CardFooter>
            <Button variant="outline" className="w-full" asChild>
              <Link href="/settings/openappa">Open GitHub sync settings</Link>
            </Button>
          </CardFooter>
        )}
      </Card>
    </AuthCallbackLayout>
  );
}

function finish(step: "created" | "installed") {
  notifyGithubAppSetup(step);
  // Only a window the setup dialog opened can close itself; a full tab stays.
  window.close();
}
