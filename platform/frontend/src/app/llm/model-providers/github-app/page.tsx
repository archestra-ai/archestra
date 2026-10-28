"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AppLogo } from "@/components/app-logo";
import { AuthCallbackLayout } from "@/components/auth-callback-layout";
import { notifyGithubAppSetup } from "@/components/github-app-setup/github-app-window";
import { shortGithubAppError } from "@/components/github-app-setup/short-error";
import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCompleteCopilotGithubApp } from "@/lib/github-copilot-app.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { COPILOT_SETUP_CHANNEL } from "../_parts/copilot-github-app-setup";

/**
 * Where GitHub returns the GitHub Copilot setup tab after creating or
 * installing its GitHub App. It reports back to the connect dialog and
 * closes itself; it only stays up when the browser keeps the tab open or the
 * setup failed.
 */
export default function CopilotGithubAppReturnPage() {
  const appName = useAppName();
  const started = useRef(false);
  const complete = useCompleteCopilotGithubApp();
  const [step, setStep] = useState<"created" | "installed" | "invalid" | null>(
    null,
  );
  useEffect(() => {
    let active = true;
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
        body: `Saving it to ${appName}. This takes a few seconds.`,
      }
    : failed
      ? {
          title: "GitHub App setup didn't finish",
          body: complete.error
            ? shortGithubAppError(complete.error.message)
            : "GitHub didn't send back what the setup needs.",
        }
      : step === "created"
        ? {
            title: "GitHub App created",
            body: `Go back to ${appName} to install it.`,
          }
        : {
            title: "GitHub App installed",
            body: `Go back to ${appName} to finish.`,
          };

  return (
    <AuthCallbackLayout>
      <div className="w-full max-w-md space-y-4">
        <AppLogo />
        <Card aria-live="polite" aria-atomic="true">
          <CardHeader>
            <CardTitle>{copy.title}</CardTitle>
            <CardDescription>{copy.body}</CardDescription>
          </CardHeader>
          {/* Two buttons high in every state, so the card never resizes. */}
          <CardContent className="flex min-h-20 flex-col gap-2">
            {pending ? (
              <div className="flex h-20 items-center justify-center">
                <LoadingState
                  variant="inline"
                  label="Saving the GitHub App"
                  showLabel
                />
              </div>
            ) : failed ? (
              <Button asChild>
                <Link href={MODEL_PROVIDERS}>
                  <span>{`Start again in ${appName}`}</span>
                </Link>
              </Button>
            ) : (
              <>
                <Button type="button" onClick={() => window.close()}>
                  <span>Close this tab</span>
                </Button>
                <Button variant="ghost" asChild>
                  <Link href={MODEL_PROVIDERS}>
                    <span>Open Model Providers</span>
                  </Link>
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AuthCallbackLayout>
  );
}

const MODEL_PROVIDERS = "/llm/model-providers";

function finish(step: "created" | "installed") {
  notifyGithubAppSetup(step, COPILOT_SETUP_CHANNEL);
  window.close();
}
