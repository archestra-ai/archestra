"use client";

import { Check, ExternalLink, Loader2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils/tailwind";

/**
 * Claude's sign-in as two numbered steps whose controls share one column:
 * open Claude's sign-in page, then paste the code it shows. `submitLabel`
 * puts the submit button beside the code field, for places with no dialog
 * footer to hold it.
 */
export function ClaudeCodeSignInSteps({
  authorizationUrl,
  code,
  onCodeChange,
  onSubmit,
  submitting,
  submitLabel,
}: {
  /** Claude's sign-in page for this flow, once the server has one. */
  authorizationUrl?: string;
  code: string;
  onCodeChange: (code: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  submitLabel?: string;
}) {
  const id = useId();
  const [opened, setOpened] = useState(false);
  const hasCode = code.trim().length > 0;
  const submit = () => {
    if (hasCode && !submitting) onSubmit();
  };

  return (
    <ol className="relative space-y-4">
      <SignInStep
        number={1}
        state={opened || hasCode ? "done" : "current"}
        connector={opened || hasCode ? "active" : "idle"}
        title="Sign in at Claude"
        description="Opens Claude's sign-in page in a new tab."
        descriptionId={`${id}-open`}
        control={
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-between"
            asChild
          >
            <a
              href={authorizationUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-describedby={`${id}-open`}
              onClick={() => setOpened(true)}
            >
              <span className="flex items-center gap-2">
                <RuntimeCredentialIcon
                  icon="logo:anthropic"
                  className="size-4"
                  size={16}
                />
                <span>{opened ? "Open again" : "Open Claude"}</span>
              </span>
              <ExternalLink className="size-3.5 text-muted-foreground" />
            </a>
          </Button>
        }
      />
      <SignInStep
        number={2}
        state={
          submitting
            ? "working"
            : hasCode
              ? "done"
              : opened
                ? "current"
                : "upcoming"
        }
        title="Paste the code"
        description="Claude shows a code once you're signed in."
        descriptionId={`${id}-code`}
        control={
          <div className="flex gap-2">
            <Input
              aria-label="Authorization code"
              aria-describedby={`${id}-code`}
              placeholder={submitLabel ? "Paste code" : "Authorization code"}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="h-8 min-w-0 font-mono"
              value={code}
              disabled={submitting}
              onChange={(event) => onCodeChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // Inside another form (the credentials dialog), Enter would
                // otherwise submit that form instead of finishing sign-in.
                event.preventDefault();
                submit();
              }}
            />
            {submitLabel && (
              <Button
                type="button"
                size="sm"
                disabled={!hasCode || submitting}
                onClick={submit}
              >
                {submitLabel}
              </Button>
            )}
          </div>
        }
      />
    </ol>
  );
}

// ===

type StepState = "upcoming" | "current" | "done" | "working";

function SignInStep({
  number,
  state,
  connector,
  title,
  description,
  descriptionId,
  control,
}: {
  number: number;
  state: StepState;
  /** Draws the line down to the next step. */
  connector?: "idle" | "active";
  title: string;
  description: string;
  descriptionId: string;
  control: ReactNode;
}) {
  return (
    <li className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 sm:grid-cols-[1.25rem_minmax(0,1fr)_16rem] sm:items-center">
      {connector && (
        <span
          aria-hidden
          className={cn(
            "absolute top-6 -bottom-3.5 left-2.5 w-px -translate-x-1/2 transition-colors sm:top-[calc(50%+0.875rem)] sm:-bottom-9",
            connector === "active" ? "bg-primary/60" : "bg-border",
          )}
        />
      )}
      <StepMarker number={number} state={state} />
      <div className="min-w-0 space-y-0.5">
        <p
          className={cn(
            "text-sm font-medium leading-5",
            state === "upcoming" && "text-muted-foreground",
          )}
        >
          {title}
        </p>
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      </div>
      <div className="col-start-2 sm:col-start-3">{control}</div>
    </li>
  );
}

function StepMarker({ number, state }: { number: number; state: StepState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 flex size-5 items-center justify-center rounded-full border bg-background text-[11px] font-medium tabular-nums transition-colors",
        state === "upcoming" && "border-border text-muted-foreground",
        state === "current" && "border-primary text-primary",
        (state === "done" || state === "working") &&
          "border-primary bg-primary text-primary-foreground",
      )}
    >
      {state === "working" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : state === "done" ? (
        <Check className="size-3" strokeWidth={3} />
      ) : (
        <span>{number}</span>
      )}
    </span>
  );
}
