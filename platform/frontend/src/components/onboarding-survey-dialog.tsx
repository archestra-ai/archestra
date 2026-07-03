"use client";

import type { Permissions } from "@archestra/shared/permission.types";
import posthog from "posthog-js";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useOnboardingSurveyEligibility,
  useSubmitOnboardingSurvey,
} from "@/lib/onboarding/onboarding.query";
import { cn } from "@/lib/utils";

/**
 * One-time first-login survey for admins of an empty, unlicensed instance.
 * Deliberately non-dismissible (no close button, Escape and outside clicks are
 * ignored): the survey reappears next session until submitted once. Submitting
 * always marks the organization done — even when the answers can't reach the
 * website — so an airgapped admin is never asked twice.
 */
export function OnboardingSurveyDialog() {
  const { data: isAdmin } = useHasPermissions(SURVEY_ADMIN_PERMISSION);
  const { data: eligibility } = useOnboardingSurveyEligibility({
    enabled: isAdmin === true,
  });
  const { mutate: submitSurvey, isPending } = useSubmitOnboardingSurvey();
  const appName = useAppName();

  const [submitted, setSubmitted] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [workEnvironment, setWorkEnvironment] = useState<string | null>(null);
  const [referralSource, setReferralSource] = useState<string | null>(null);
  const [workEmail, setWorkEmail] = useState("");

  const open = isAdmin === true && eligibility?.eligible === true && !submitted;

  useEffect(() => {
    if (open) posthog.capture("onboarding_survey_shown");
  }, [open]);

  const emailValid =
    workEmail === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workEmail);
  const canSubmit =
    role !== null &&
    workEnvironment !== null &&
    referralSource !== null &&
    emailValid &&
    !isPending;

  const handleSubmit = () => {
    if (!role || !workEnvironment || !referralSource) return;
    submitSurvey(
      {
        role,
        workEnvironment,
        referralSource,
        ...(workEmail ? { workEmail } : {}),
      },
      {
        onSuccess: () => {
          posthog.capture("onboarding_survey_submitted");
          setSubmitted(true);
        },
      },
    );
  };

  const answeredCount = [role, workEnvironment, referralSource].filter(
    (value) => value !== null,
  ).length;

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        {/* Header with a soft radial wash in the org's primary color */}
        <DialogHeader className="relative space-y-2 px-8 pt-8 pb-6 text-left">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-transparent"
          />
          <DialogTitle className="text-2xl font-semibold leading-tight tracking-tight">
            Please help us make {appName} better! ❤️
          </DialogTitle>
          {/* Progress: fills as the three questions get answered */}
          <div className="mt-3 flex items-center gap-3">
            <div className="flex flex-1 gap-1">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className={cn(
                    "h-0.75 flex-1 rounded-full transition-colors duration-300",
                    index < answeredCount ? "bg-primary" : "bg-border",
                  )}
                />
              ))}
            </div>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {answeredCount}/3
            </span>
          </div>
        </DialogHeader>

        <div className="divide-y divide-border/70 border-t border-border/70">
          <SurveyQuestion
            index={1}
            label="What do you do?"
            options={ROLE_OPTIONS}
            value={role}
            onChange={setRole}
          />
          <SurveyQuestion
            index={2}
            label="Where do you spend your days?"
            options={WORK_ENVIRONMENT_OPTIONS}
            value={workEnvironment}
            onChange={setWorkEnvironment}
          />
          <SurveyQuestion
            index={3}
            label="How'd you find us?"
            options={REFERRAL_SOURCE_OPTIONS}
            value={referralSource}
            onChange={setReferralSource}
          />
          <div className="grid grid-cols-[2rem_1fr] gap-x-3 px-8 py-6">
            <span
              aria-hidden
              className="pt-px font-mono text-[11px] tabular-nums text-muted-foreground/60"
            >
              04
            </span>
            <div>
              <Label
                htmlFor="onboarding-survey-email"
                className="block text-sm font-medium leading-none"
              >
                Email for very concise important updates{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="onboarding-survey-email"
                type="email"
                placeholder="you@company.com"
                value={workEmail}
                onChange={(event) => setWorkEmail(event.target.value)}
                aria-invalid={!emailValid}
                className="mt-2 h-9 border-0 border-b border-border bg-transparent px-0 font-mono text-sm shadow-none rounded-none focus-visible:border-primary focus-visible:ring-0 aria-invalid:border-destructive dark:bg-transparent"
              />
            </div>
          </div>
        </div>

        <div className="border-t border-border/70 bg-muted/40 px-8 py-5">
          <Button
            size="lg"
            className="w-full transition-all"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {isPending ? "Sending…" : "Send"}
            {!isPending && <span aria-hidden>→</span>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// === Internal ===

const SURVEY_ADMIN_PERMISSION: Permissions = {
  organizationSettings: ["update"],
};

const ROLE_OPTIONS = [
  "Software engineer",
  "SRE, DevOps & Platform",
  "AI or ML team",
  "Security engineer",
  "Engineering leader (CTO, EM)",
  "Other",
];

const WORK_ENVIRONMENT_OPTIONS = [
  "Startup (<50 people)",
  "Mid-size company",
  "Large enterprise",
  "Agency or consultancy",
  "Studying, between things",
];

const REFERRAL_SOURCE_OPTIONS = [
  "GitHub",
  "Reddit",
  "YouTube",
  "Colleagues or friends",
  "Conference",
  "Search engine",
  "Other",
];

function SurveyQuestion({
  index,
  label,
  options,
  value,
  onChange,
}: {
  index: number;
  label: string;
  options: string[];
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="grid grid-cols-[2rem_1fr] gap-x-3 px-8 py-6">
      {/*
       * Spacing inside the question is explicit margins, not `space-y`:
       * the legend is `display: contents` (needed so the visible label can
       * live inside the grid flow), and margins on `display: contents`
       * elements are ignored — `space-y` would silently collapse to 0.
       */}
      <span
        aria-hidden
        className="pt-px font-mono text-[11px] tabular-nums text-muted-foreground/60"
      >
        0{index}
      </span>
      <div>
        <legend className="contents">
          <span className="block text-sm font-medium leading-none">
            {label}
          </span>
        </legend>
        <div className="mt-3.5 flex flex-wrap gap-x-1.5 gap-y-2">
          {options.map((option) => {
            const selected = value === option;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange(option)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-all duration-150",
                  "hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-primary bg-primary text-primary-foreground shadow-sm"
                    : "border-border bg-transparent text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}
