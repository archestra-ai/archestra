"use client";

import {
  type BatteryCredentialRequest,
  BatteryCredentialRequestSchema,
} from "@archestra/shared";
import {
  BatteryCharging,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRight,
  ChevronRightIcon,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import {
  RuntimeCredentialDefinitionDialog,
  slugifyCredentialKey,
} from "@/components/settings/runtime-credential-definition-dialog";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFeature } from "@/lib/config/config.query";
import {
  type RuntimeCredentialDefinition,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";
import { cn } from "@/lib/utils/tailwind";

type Battery = BatteryCredentialRequest["batteries"][number];
type Choice = { kind: "key"; key: string } | { kind: "skipped" };
type Adding =
  | { battery: Battery; variable: string; step: "define" }
  | { battery: Battery; variable: string; step: "connect"; id: string };

/**
 * One step per battery the configuration agent asked credentials for: each
 * variable is bound to an organization credential, a new one made through the
 * Settings dialogs, or skipped. Done sends one message naming only keys.
 */
export function BatteryCredentialsTool({
  request,
  toolCallId,
  onSendMessage,
}: {
  request: BatteryCredentialRequest;
  toolCallId: string;
  onSendMessage?: (text: string) => void;
}) {
  const sentKey = `battery-credentials:${toolCallId}`;
  const [sent, setSent] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [adding, setAdding] = useState<Adding | null>(null);
  const credentials = useRuntimeCredentials();
  const byosEnabled = useFeature("byosEnabled") === true;
  useEffect(() => setSent(sessionStorage.getItem(sentKey)), [sentKey]);
  const all = credentials.data ?? [];
  const options = all.filter(
    (entry) => entry.allowOrganization && entry.organizationConfigured,
  );
  const connecting =
    adding?.step === "connect"
      ? all.find((entry) => entry.id === adding.id)
      : undefined;
  const battery = request.batteries[index] ?? request.batteries[0];
  const total = request.batteries.length;
  const isLast = index === total - 1;
  const variables = request.batteries.flatMap((entry) =>
    entry.credentials.map((variable) => ({ battery: entry, variable })),
  );
  const complete = variables.every(
    ({ battery, variable }) => choices[choiceId(battery, variable)],
  );
  const choose = (battery: Battery, variable: string, choice: Choice) =>
    setChoices((current) => ({
      ...current,
      [choiceId(battery, variable)]: choice,
    }));

  const done = () => {
    const message = `Battery credentials: ${
      variables
        .map(({ battery, variable }) => {
          const choice = choices[choiceId(battery, variable)];
          return `${battery.title} ${variable} → ${choice?.kind === "key" ? choice.key : "skipped"}`;
        })
        .join("; ") || "nothing to bind"
    }.`;
    sessionStorage.setItem(sentKey, message);
    setSent(message);
    onSendMessage?.(message);
  };

  return (
    <div
      data-testid="battery-credentials-card"
      className="not-prose relative mb-4 w-full max-w-2xl overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm"
    >
      <div className="flex items-center gap-3 px-4 pt-3">
        {total > 1 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            <span className="sr-only">Battery </span>
            {index + 1} of {total}
          </span>
        ) : null}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <BatteryCharging className="size-3.5 shrink-0" aria-hidden />
          <span>Battery credentials</span>
        </span>
      </div>
      <section
        key={battery.name}
        aria-label={battery.title}
        className="flex min-w-0 flex-col gap-3 p-4"
      >
        <div>
          <p className="text-sm font-medium">{battery.title}</p>
          {battery.benefit ? (
            <p className="text-sm leading-6 text-muted-foreground">
              {battery.benefit}
            </p>
          ) : null}
        </div>
        {battery.setup.length > 0 ? <SetupSteps steps={battery.setup} /> : null}
        {battery.credentials.map((variable) => {
          const choice = choices[choiceId(battery, variable)];
          const id = `battery-credential-${toolCallId}-${choiceId(battery, variable)}`;
          const existing = existingDefinition({
            battery,
            variable,
            credentials: all,
          });
          return (
            <div key={variable} className="space-y-1">
              <Label htmlFor={id} className="font-mono text-xs">
                {variable}
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={choice?.kind === "key" ? choice.key : ""}
                  disabled={sent !== null}
                  onValueChange={(key) =>
                    choose(battery, variable, { kind: "key", key })
                  }
                >
                  <SelectTrigger id={id} size="sm" className="min-w-48 flex-1">
                    <SelectValue
                      placeholder={
                        choice?.kind === "skipped"
                          ? "Skipped"
                          : "Pick a credential"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {options.map((entry) => (
                      <SelectItem key={entry.key} value={entry.key}>
                        {entry.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={sent !== null}
                  onClick={() =>
                    setAdding(
                      existing
                        ? {
                            battery,
                            variable,
                            step: "connect",
                            id: existing.id,
                          }
                        : { battery, variable, step: "define" },
                    )
                  }
                >
                  <span>
                    {existing ? `Connect ${existing.name}` : "Add new token"}
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={sent !== null}
                  aria-label={`Skip ${variable}`}
                  onClick={() => choose(battery, variable, { kind: "skipped" })}
                >
                  <span>Skip</span>
                </Button>
              </div>
            </div>
          );
        })}
      </section>
      <div
        className={cn(
          "flex items-center justify-end gap-1 px-3 pb-3",
          total > 1 && "border-t border-border/60 py-2",
        )}
      >
        {total > 1 && index > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setIndex(index - 1)}
          >
            <ChevronLeftIcon aria-hidden />
            <span>Back</span>
          </Button>
        ) : null}
        {isLast ? (
          <Button
            key="done"
            type="button"
            size="sm"
            disabled={!complete || sent !== null}
            onClick={done}
          >
            <CheckIcon aria-hidden />
            <span>{sent === null ? "Done" : "Sent"}</span>
          </Button>
        ) : (
          <Button
            key="next"
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setIndex(index + 1)}
          >
            <span>Next</span>
            <ChevronRightIcon aria-hidden />
          </Button>
        )}
      </div>
      {adding?.step === "define" ? (
        <RuntimeCredentialDefinitionDialog
          definition={null}
          initialKind="secret"
          initialScope="organization"
          initialValues={{
            name: tokenName(adding.battery, adding.variable),
            description: `Read by the ${adding.battery.title} battery's helpers.`,
            icon: null,
          }}
          hideProvidedBy
          onClose={() => setAdding(null)}
          onCreated={(id) => setAdding({ ...adding, step: "connect", id })}
        />
      ) : null}
      {adding?.step === "connect" && connecting ? (
        <RuntimeCredentialConnectionDialog
          definition={connecting}
          scope="organization"
          useExternalSecretsManager={byosEnabled}
          onClose={() => setAdding(null)}
          onConnected={() =>
            choose(adding.battery, adding.variable, {
              kind: "key",
              key: connecting.key,
            })
          }
        />
      ) : null}
    </div>
  );
}

/** The card's batteries from the tool result, or null when it holds none. */
export function parseBatteryCredentialRequest(
  output: unknown,
): BatteryCredentialRequest | null {
  const structured =
    typeof output === "object" &&
    output !== null &&
    "structuredContent" in output
      ? output.structuredContent
      : undefined;
  const parsed = BatteryCredentialRequestSchema.safeParse(structured);
  return parsed.success ? parsed.data : null;
}

// === Internal helpers ===

function SetupSteps({ steps }: { steps: string[] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button
          variant="link"
          size="xs"
          className="group h-auto p-0 text-muted-foreground"
        >
          <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
          <span>How to get the token</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          {steps.map((step) => (
            <li key={step}>
              <StepText text={step} />
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A setup line with its URLs as links and its backticked names as code. */
function StepText({ text }: { text: string }) {
  return (
    <>
      {text.split(STEP_TOKEN).map((part, index) => {
        const key = `${index}-${part}`;
        if (part.startsWith("`") && part.endsWith("`") && part.length > 1)
          return (
            <code key={key} className="rounded bg-muted px-1 text-xs">
              {part.slice(1, -1)}
            </code>
          );
        if (/^https?:\/\//.test(part))
          return (
            <a
              key={key}
              href={part}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {part}
            </a>
          );
        return <Fragment key={key}>{part}</Fragment>;
      })}
    </>
  );
}

/**
 * The organization secret an earlier "Add new token" made for this variable,
 * so a second attempt connects it instead of making a duplicate.
 */
function existingDefinition(params: {
  battery: Battery;
  variable: string;
  credentials: RuntimeCredentialDefinition[];
}) {
  const name = tokenName(params.battery, params.variable);
  const key = slugifyCredentialKey(name);
  return params.credentials.find(
    (entry) =>
      entry.kind === "secret" &&
      entry.allowOrganization &&
      (entry.key === key || entry.name === name),
  );
}

/** One token per variable: a battery reading two gets two definitions. */
function tokenName(battery: Battery, variable: string) {
  return battery.credentials.length > 1
    ? `${battery.title} ${variable} token`
    : `${battery.title} token`;
}

function choiceId(battery: Battery, variable: string) {
  return `${battery.name}:${variable}`;
}

// A URL stops before trailing sentence punctuation.
const STEP_TOKEN = /(`[^`]+`|https?:\/\/[^\s`]*[^\s`.,:;)])/;
