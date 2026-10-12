"use client";

import { Check, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { notifyGithubAppSetup } from "@/app/openappa/_parts/github-app-channel";
import { AuthCallbackLayout } from "@/components/auth-callback-layout";
import { LoadingState } from "@/components/loading";
import { OpenAppaSolidIcon } from "@/components/openappa-icon";
import { Button } from "@/components/ui/button";
import { useCompleteAppaGithubApp } from "@/lib/openappa-github-sync.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Where GitHub returns the setup tab after creating or installing the OpenAPPA
 * GitHub App. It reports back to the setup dialog and closes itself; the page
 * only stays up when the browser refuses to close the tab or setup failed.
 */
export default function OpenAppaGithubAppSetupReturn() {
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
  const copy = pending
    ? {
        title: "Connecting the GitHub App",
        body: "Saving its keys to Archestra. This takes a few seconds.",
      }
    : failed
      ? {
          title: "GitHub App setup didn't finish",
          body:
            complete.error?.message ??
            "GitHub didn't send back what setup needs.",
        }
      : step === "created"
        ? {
            title: "GitHub App created",
            body: "Head back to Archestra to install it on your organization.",
          }
        : {
            title: "GitHub App installed",
            body: "Head back to Archestra to choose the policy repository.",
          };

  return (
    <AuthCallbackLayout>
      <div
        className="flex w-full max-w-sm flex-col items-center text-center"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="relative mb-6">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-[#161413] shadow-sm">
            <OpenAppaSolidIcon className="w-9 text-[#EFEEEB]" />
          </div>
          {pending ? null : (
            <span
              className={cn(
                "absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border-2 border-background text-white",
                failed ? "bg-destructive" : "bg-emerald-600",
              )}
            >
              {failed ? (
                <CircleAlert className="size-3.5" aria-hidden />
              ) : (
                <Check className="size-3.5" strokeWidth={3} aria-hidden />
              )}
            </span>
          )}
        </div>
        <h1 className="text-lg font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-1.5 text-balance text-sm text-muted-foreground">
          {copy.body}
        </p>
        <div className="mt-6 flex w-full flex-col gap-2">
          {pending ? (
            <LoadingState variant="inline" label="Saving the GitHub App" />
          ) : failed ? (
            <Button asChild>
              <Link href="/settings/openappa">Start again in Archestra</Link>
            </Button>
          ) : (
            <>
              <Button onClick={() => window.close()}>Close this tab</Button>
              <Button variant="ghost" asChild>
                <Link href="/settings/openappa">Open GitHub sync settings</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </AuthCallbackLayout>
  );
}

function finish(step: "created" | "installed") {
  notifyGithubAppSetup(step);
  // Only a tab the setup dialog opened can close itself; otherwise it stays.
  window.close();
}
