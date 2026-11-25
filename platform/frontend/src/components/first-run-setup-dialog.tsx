"use client";

import type { Permissions } from "@archestra/shared/permission.types";
import { HeartHandshake, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogTitle,
} from "@/components/ui/dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useCompleteFirstRunSetup,
  useFirstRunSetup,
} from "@/lib/onboarding/onboarding.query";
import { useShellReady } from "@/lib/shell-deferral";
import { cn } from "@/lib/utils/tailwind";

/**
 * Two-step dialog an admin sees once on a new, unlicensed installation:
 * mailing-list signup, then the telemetry choice. It has no close button and
 * ignores Escape and outside clicks, but both steps can be passed without
 * answering (Skip, then Done), and finishing records the organization as done
 * even when the signup can't reach the website.
 */
export function FirstRunSetupDialog() {
  const preview = useIsPreview();
  const { data: isAdmin } = useHasPermissions(ADMIN_PERMISSION);
  const shellReady = useShellReady();
  const { data: setup } = useFirstRunSetup({
    enabled: isAdmin === true && shellReady && !preview,
  });
  const { mutate: completeSetup, isPending } = useCompleteFirstRunSetup();
  const appName = useAppName();

  const [step, setStep] = useState<"email" | "telemetry">("email");
  const [subscribe, setSubscribe] = useState(false);
  const [done, setDone] = useState(false);
  const form = useForm<FormValues>({
    defaultValues: { email: "", telemetryEnabled: true },
  });
  const email = form.watch("email").trim();
  const telemetryEnabled = form.watch("telemetryEnabled");
  const emailValid = EMAIL_PATTERN.test(email);

  const open = !done && (preview || (isAdmin === true && setup?.show === true));

  const goToTelemetry = (withSubscription: boolean) => {
    setSubscribe(withSubscription);
    setStep("telemetry");
  };

  const finish = () => {
    completeSetup(
      { telemetryEnabled, ...(subscribe && emailValid ? { email } : {}) },
      { onSuccess: () => setDone(true) },
    );
  };

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        // The telemetry step has no description; this tells Radix so.
        {...(step === "telemetry" ? { "aria-describedby": undefined } : {})}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="gap-0 overflow-y-auto rounded-xl p-8 sm:max-w-[440px]"
      >
        {step === "email" ? (
          <DialogForm
            key="email"
            onSubmit={() => {
              if (emailValid) goToTelemetry(true);
            }}
          >
            <div className={STEP_CLASS}>
              <Progress current={1} />
              {/* Written as a short letter from the team, not a form. */}
              {/* Screen readers still need a name for the dialog. */}
              <DialogTitle className="sr-only">
                Welcome to {appName}
              </DialogTitle>
              <DialogDescription asChild>
                <div className="mt-6 space-y-3 text-sm leading-6 text-pretty text-foreground">
                  <p>
                    Thank you for trying open-source {appName}! We believe the
                    best proof of concept is the one you can run yourself, and
                    we are glad you are giving it a go.
                  </p>
                  <p>
                    {appName} evolves quickly. If you are open to it, we would
                    be grateful for your email, so we can occasionally send a
                    short note about major changes and important security
                    announcements.
                  </p>
                  <p className="text-muted-foreground">
                    Usually our CEO or CTO write those emails, so it is not
                    marketing fluff.
                  </p>
                </div>
              </DialogDescription>

              <Label htmlFor="first-run-setup-email" className="sr-only">
                Email
              </Label>
              <Input
                id="first-run-setup-email"
                type="email"
                autoFocus
                autoComplete="email"
                placeholder="you@company.com"
                aria-invalid={email !== "" && !emailValid}
                className="mt-6 h-10"
                {...form.register("email")}
              />
              <Button
                type="submit"
                disabled={!emailValid}
                className="mt-3 w-full"
              >
                Subscribe
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="mt-1 w-full text-muted-foreground"
                onClick={() => goToTelemetry(false)}
              >
                Skip
              </Button>
            </div>
          </DialogForm>
        ) : (
          <DialogForm key="telemetry" onSubmit={finish}>
            <div className={STEP_CLASS}>
              <Progress current={2} />
              <DialogTitle className={TITLE_CLASS}>
                Product Telemetry
              </DialogTitle>

              <div className="mt-6 flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3">
                <Label htmlFor="first-run-setup-telemetry">Share</Label>
                <Switch
                  id="first-run-setup-telemetry"
                  // The visible label is just "Share"; say what is shared.
                  aria-label="Share product telemetry"
                  checked={telemetryEnabled}
                  onCheckedChange={(checked) =>
                    form.setValue("telemetryEnabled", checked)
                  }
                />
              </div>

              {!telemetryEnabled && (
                <InlineNotice variant="info" className="mt-3">
                  <HeartHandshake />
                  <InlineNoticeText>
                    Without telemetry it is hard for us to improve {appName} and
                    notice bugs. We kindly ask you to keep it on.
                  </InlineNoticeText>
                </InlineNotice>
              )}

              <ul
                className={cn(
                  "mt-5 transition-opacity",
                  !telemetryEnabled && "opacity-50",
                )}
              >
                <Point icon={Lock} lead="Never sent.">
                  Prompts, chat messages, tool calls, API keys and secrets.
                </Point>
              </ul>

              <div className="mt-7 flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={isPending}
                  onClick={() => setStep("email")}
                >
                  Back
                </Button>
                <Button type="submit" disabled={isPending} className="flex-1">
                  {isPending ? "Saving…" : "Done"}
                </Button>
              </div>
            </div>
          </DialogForm>
        )}
      </DialogContent>
    </Dialog>
  );
}

// === Internal ===

type FormValues = { email: string; telemetryEnabled: boolean };

const ADMIN_PERMISSION: Permissions = {
  organizationSettings: ["update"],
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STEP_CLASS = "animate-in fade-in-0 duration-300";
const TITLE_CLASS = "mt-6 text-2xl leading-tight tracking-tight";

/**
 * Opens the dialog in development builds even when it would not show:
 * `?first-run-setup=preview`. Everything else works as for real: the email
 * goes to the mailing list and the telemetry choice is saved.
 */
const PREVIEW_PARAM = "first-run-setup";

function useIsPreview(): boolean {
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const value = new URLSearchParams(window.location.search).get(
      PREVIEW_PARAM,
    );
    setPreview(value === "preview");
  }, []);
  return preview;
}

/** Two segments; the ones up to the current step are filled. */
function Progress({ current }: { current: 1 | 2 }) {
  return (
    <div
      role="img"
      aria-label={`Step ${current} of 2`}
      className="flex w-14 gap-1.5"
    >
      {[1, 2].map((index) => (
        <span
          key={index}
          className={cn(
            "h-1 flex-1 rounded-full",
            index <= current ? "bg-primary" : "bg-border",
          )}
        />
      ))}
    </div>
  );
}

/** An icon, a short lead in the foreground color, then the detail. */
function Point({
  icon: Icon,
  lead,
  children,
}: {
  icon: typeof Lock;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 text-sm leading-snug">
      <Icon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">{lead}</span> {children}
      </p>
    </li>
  );
}
