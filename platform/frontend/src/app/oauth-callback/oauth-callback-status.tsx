import {
  AlertTriangle,
  ArrowRight,
  Check,
  KeyRound,
  LockKeyhole,
  Server,
  ShieldCheck,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type OAuthCallbackStatusProps =
  | {
      status: "processing";
      phase: "initializing" | "completing";
    }
  | {
      status: "error";
      errorTitle: string;
      errorDescription: string;
      actionLabel: string;
      onAction: () => void;
    };

export function OAuthCallbackStatus(props: OAuthCallbackStatusProps) {
  const isError = props.status === "error";
  const copy = isError
    ? {
        eyebrow: "Connection interrupted",
        title: "We couldn't finish the connection",
        description:
          "Your existing setup is unchanged. Review the details below, then return and try again.",
      }
    : getProcessingCopy(props.phase);

  return (
    <Card
      className="grid w-full overflow-hidden rounded-2xl border-border/70 bg-card/95 py-0 shadow-[0_28px_80px_-38px_color-mix(in_oklab,var(--foreground)_28%,transparent)] backdrop-blur-sm md:grid-cols-[minmax(19rem,0.82fr)_minmax(24rem,1.18fr)]"
      aria-live="polite"
    >
      <ConnectionDiagram status={props.status} />

      <section className="flex min-h-[25rem] flex-col justify-between p-7 sm:p-10 md:min-h-[30rem] md:p-12">
        <div>
          <div className="mb-8 flex size-11 items-center justify-center rounded-xl border border-primary/15 bg-primary/8 text-primary shadow-[inset_0_1px_0_color-mix(in_oklab,var(--background)_70%,transparent)]">
            {isError ? (
              <AlertTriangle className="size-5" aria-hidden="true" />
            ) : (
              <ShieldCheck className="size-5" aria-hidden="true" />
            )}
          </div>

          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {copy.eyebrow}
          </p>
          <h1 className="max-w-xl text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">
            {copy.title}
          </h1>
          <p className="mt-4 max-w-lg text-base leading-7 text-muted-foreground">
            {copy.description}
          </p>

          {isError && (
            <Alert variant="destructive" className="mt-8 rounded-xl">
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>{props.errorTitle}</AlertTitle>
              <AlertDescription>{props.errorDescription}</AlertDescription>
            </Alert>
          )}
        </div>

        <div className="mt-10 border-t border-border/70 pt-6">
          {isError ? (
            <Button onClick={props.onAction} size="lg" className="group">
              <span>{props.actionLabel}</span>
              <ArrowRight
                className="transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Button>
          ) : (
            <div className="flex items-start gap-3 text-sm text-muted-foreground">
              <LockKeyhole
                className="mt-0.5 size-4 shrink-0 text-foreground/70"
                aria-hidden="true"
              />
              <p className="max-w-sm leading-6">
                Keep this page open. You'll return automatically when the secure
                handoff is complete.
              </p>
            </div>
          )}
        </div>
      </section>
    </Card>
  );
}

function ConnectionDiagram({
  status,
}: {
  status: OAuthCallbackStatusProps["status"];
}) {
  const isError = status === "error";

  return (
    <aside className="relative flex min-h-[20rem] overflow-hidden border-b border-border/70 bg-muted/35 p-7 sm:p-10 md:min-h-[30rem] md:border-r md:border-b-0">
      <div className="absolute -top-24 -left-24 size-64 rounded-full bg-primary/8 blur-3xl" />
      <div className="relative flex w-full flex-col justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl border border-border/80 bg-background/80 shadow-sm">
            <LockKeyhole
              className="size-4 text-foreground/75"
              aria-hidden="true"
            />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              Secure handoff
            </p>
            <p className="text-xs text-muted-foreground">
              OAuth credentials stay protected
            </p>
          </div>
        </div>

        <output
          className="my-10 flex flex-col"
          aria-label={
            isError
              ? "OAuth connection interrupted"
              : "OAuth connection in progress"
          }
        >
          <ConnectionNode
            icon={
              isError ? (
                <AlertTriangle className="size-4" aria-hidden="true" />
              ) : (
                <Check className="size-4" aria-hidden="true" />
              )
            }
            label={
              isError ? "Authorization not completed" : "Authorization received"
            }
            state={isError ? "error" : "complete"}
          />
          <ConnectionLine active={!isError} />
          <ConnectionNode
            icon={<KeyRound className="size-4" aria-hidden="true" />}
            label={isError ? "Credentials unchanged" : "Securing credentials"}
            state={isError ? "pending" : "active"}
          />
          <ConnectionLine active={false} />
          <ConnectionNode
            icon={<Server className="size-4" aria-hidden="true" />}
            label={isError ? "MCP server unchanged" : "Connecting MCP server"}
            state="pending"
          />
        </output>

        <p className="max-w-xs text-xs leading-5 text-muted-foreground">
          OAuth access is exchanged directly with the provider and stored using
          your configured secret management.
        </p>
      </div>
    </aside>
  );
}

function ConnectionNode({
  icon,
  label,
  state,
}: {
  icon: React.ReactNode;
  label: string;
  state: "active" | "complete" | "error" | "pending";
}) {
  return (
    <div className="flex items-center gap-4">
      <div
        className={cn(
          "relative flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm",
          state === "complete" && "border-primary/20 text-primary",
          state === "active" && "border-primary/30 text-primary",
          state === "error" &&
            "border-destructive/30 bg-destructive/5 text-destructive",
          state === "pending" && "border-border/70 text-muted-foreground/60",
        )}
      >
        {state === "active" && (
          <span className="absolute inset-1 animate-pulse rounded-lg border border-primary/25 motion-reduce:animate-none" />
        )}
        <span className="relative">{icon}</span>
      </div>
      <span
        className={cn(
          "text-sm font-medium",
          state === "pending" ? "text-muted-foreground/65" : "text-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function ConnectionLine({ active }: { active: boolean }) {
  return (
    <div className="ml-[1.2rem] h-11 w-px overflow-hidden bg-border">
      {active && (
        <div className="h-full w-px animate-pulse bg-linear-to-b from-transparent via-primary to-transparent motion-reduce:animate-none" />
      )}
    </div>
  );
}

function getProcessingCopy(phase: "initializing" | "completing") {
  if (phase === "initializing") {
    return {
      eyebrow: "Secure OAuth connection",
      title: "Preparing your connection",
      description:
        "We're reading the authorization response and preparing the secure handoff.",
    };
  }

  return {
    eyebrow: "Secure OAuth connection",
    title: "Finishing the connection",
    description:
      "Your authorization is confirmed. We're securing the credentials and connecting the MCP server.",
  };
}
