"use client";

import { Check, Plus } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/tailwind";

/**
 * The numbered "how to connect" rail shared by the LLM Proxy page and the MCP
 * Gateway's Connect tab: endpoint, then how callers authenticate, then that
 * method's credential. Render `ConnectStep`s inside an `<ol>`.
 */

export type ConnectStepProps = {
  title: string;
  done?: boolean;
  /** A secondary action at the end of the title line, e.g. "+ Create new". */
  titleAction?: React.ReactNode;
  /** A short line under the title, beside `actions`. */
  detail?: React.ReactNode;
  /** The step's control, at the end of the detail line. */
  actions?: React.ReactNode;
  /** Content under the step, e.g. a key field or a request. */
  children?: React.ReactNode;
};

/** One step of the rail: a numbered marker with a line down to the next. */
export function ConnectStep({
  number,
  title,
  done,
  titleAction,
  detail,
  actions,
  children,
}: ConnectStepProps & { number: number }) {
  return (
    <li className="relative flex gap-3.5 pb-10 before:absolute before:top-8 before:bottom-1 before:left-3.5 before:w-px before:bg-border last:pb-0 last:before:hidden">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 bg-background text-xs font-semibold text-muted-foreground tabular-nums">
        {number}
      </span>
      <section className="min-w-0 flex-1 space-y-3">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-base leading-7 font-semibold">
            {title}
            {done && (
              <Check
                className="size-4 text-green-600 dark:text-green-500"
                aria-label="Done"
              />
            )}
          </h2>
          {titleAction}
        </div>
        {(detail || actions) && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {detail && (
              <div className="min-w-0 flex-[1_1_16rem] text-sm text-muted-foreground">
                {detail}
              </div>
            )}
            {actions && (
              <div className="flex flex-wrap items-center gap-2">{actions}</div>
            )}
          </div>
        )}
        {children}
      </section>
    </li>
  );
}

export type AuthMethodOption<T extends string> = {
  value: T;
  title: string;
  description: string;
  /** Where the credentials of this kind are managed; omitted when nowhere. */
  manage?: { label: string; href: string };
};

/** The one control that picks how callers authenticate, as radio cards. */
export function AuthMethodPicker<T extends string>({
  methods,
  value,
  onChange,
  unavailable,
}: {
  methods: AuthMethodOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Methods that can't be picked right now, with the reason shown on hover. */
  unavailable?: Partial<Record<T, string>>;
}) {
  const id = useId();
  return (
    <RadioGroup
      aria-label="Authentication method"
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className="grid gap-3 md:grid-cols-2"
    >
      {methods.map((method) => {
        const checked = value === method.value;
        const reason = unavailable?.[method.value];
        const card = (
          <div
            key={method.value}
            className={cn(
              "flex flex-col gap-2 rounded-md p-3",
              radioCardClass({ checked, disabled: !!reason }),
            )}
          >
            <Label
              htmlFor={`${id}-${method.value}`}
              className={cn(
                "flex items-start gap-3 font-normal",
                reason ? "cursor-not-allowed" : "cursor-pointer",
              )}
            >
              <RadioGroupItem
                id={`${id}-${method.value}`}
                value={method.value}
                disabled={!!reason}
                className="mt-0.5"
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium">
                  {method.title}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {method.description}
                </span>
              </span>
            </Label>
            {method.manage && (
              <Link
                href={method.manage.href}
                className="ml-7 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {method.manage.label} →
              </Link>
            )}
          </div>
        );
        if (!reason) return card;
        return (
          <Tooltip key={method.value}>
            <TooltipTrigger asChild>{card}</TooltipTrigger>
            <TooltipContent className="max-w-64">{reason}</TooltipContent>
          </Tooltip>
        );
      })}
    </RadioGroup>
  );
}

/**
 * The credential control: a picker of the existing ones, or — when there are
 * none yet — creating one as the primary action. With choices, creating
 * another lives on the step's title line ({@link CreateNewLink}).
 */
export function CredentialSelect({
  label,
  createLabel,
  canCreate,
  onCreate,
  options,
  value,
  onChange,
  noneLabel,
}: {
  label: string;
  createLabel: string;
  canCreate: boolean;
  onCreate: () => void;
  options: Array<{ id: string; label: string }>;
  value: string | undefined;
  onChange: (id: string | null) => void;
  /** Offered when picking nothing is valid. */
  noneLabel?: string;
}) {
  if (options.length === 0) {
    return canCreate ? (
      <Button onClick={onCreate}>
        <Plus />
        {createLabel}
      </Button>
    ) : null;
  }
  return (
    <Select
      value={value ?? (noneLabel ? NONE_VALUE : "")}
      onValueChange={(next) => onChange(next === NONE_VALUE ? null : next)}
    >
      <SelectTrigger aria-label={label} className="w-64">
        <SelectValue placeholder={`Choose a ${label.toLowerCase()}`} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel && <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The secondary "+ Create new" on a step's title line, beside a picker that
 * already has choices. It opens the create dialog, which hands the new
 * credential back already selected.
 */
export function CreateNewLink({
  label,
  onCreate,
}: {
  label: string;
  onCreate: () => void;
}) {
  return (
    <Button
      variant="link"
      size="sm"
      className="h-7 px-0"
      aria-label={label}
      onClick={onCreate}
    >
      <Plus />
      Create new
    </Button>
  );
}

/**
 * How an OAuth client gets the access token a request sends: a token request
 * for an application, or the sign-in flow for user tokens.
 */
export function OauthTokenRequest({
  clientId,
  grantType,
  scope,
}: {
  clientId: string;
  grantType: "client_credentials" | "authorization_code";
  scope: string;
}) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  if (grantType === "authorization_code") {
    return (
      <p className="text-sm text-muted-foreground">
        Your app signs the user in at{" "}
        <code className="font-mono text-xs">
          {origin}/api/auth/oauth2/authorize
        </code>{" "}
        (PKCE, scope <code className="font-mono text-xs">{scope}</code>), then
        exchanges the code for an access token at{" "}
        <code className="font-mono text-xs">
          {origin}/api/auth/oauth2/token
        </code>
        .
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Get an access token with the client's secret.
      </p>
      <TerminalBlock
        code={[
          `curl -X POST "${origin}/api/auth/oauth2/token" \\`,
          `  -d "grant_type=client_credentials" \\`,
          `  -d "client_id=${clientId}" \\`,
          `  -d "client_secret=$CLIENT_SECRET" \\`,
          `  -d "scope=${scope}"`,
        ].join("\n")}
      />
    </div>
  );
}

const NONE_VALUE = "__none__";
