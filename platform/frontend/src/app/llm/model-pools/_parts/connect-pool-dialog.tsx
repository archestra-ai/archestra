"use client";

import {
  Info,
  KeyRound,
  type LucideIcon,
  Plug,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import { useId, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useConnectionBaseUrl } from "@/components/virtual-key-connection-base-url";
import { CodeExample } from "@/components/virtual-key-connection-guide";
import {
  buildCurlExample,
  getProxyBaseUrl,
  type RequestTarget,
} from "@/components/virtual-key-request-example";
import type { ModelPool } from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";

/** What the view needs of a pool, which a pool just created also has. */
export type ConnectablePool = Pick<ModelPool, "id" | "name">;

type Endpoint = "model-router" | "anthropic" | "openai";
type Credential = "standard" | "token";

const ENDPOINTS: Choice<Endpoint>[] = [
  {
    value: "model-router",
    label: "Model Router",
    description: "OpenAI-compatible, any client",
    icon: Waypoints,
  },
  {
    value: "anthropic",
    label: "Anthropic API",
    description: "Claude Code, Anthropic SDK",
    icon: Plug,
  },
  {
    value: "openai",
    label: "OpenAI API",
    description: "OpenAI SDK, Chat Completions",
    icon: Plug,
  },
];

const CREDENTIALS: Choice<Credential>[] = [
  {
    value: "standard",
    label: "Virtual key",
    description: "One that maps a member's key, or lists this pool",
    icon: KeyRound,
  },
  {
    value: "token",
    label: "OAuth client",
    description: "A token for a client that maps a member's key",
    icon: ShieldCheck,
  },
];

/**
 * How clients call a pool: by its name, on any endpoint that serves its
 * members, with a credential that may use it. Shown after a pool is created
 * too, as `ready`.
 */
export function ConnectPoolDialog({
  pool,
  ready,
  onOpenChange,
}: {
  pool: ConnectablePool;
  ready: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const connectionBaseUrl = useConnectionBaseUrl();
  const [endpoint, setEndpoint] = useState<Endpoint>("model-router");
  const [credential, setCredential] = useState<Credential>("standard");
  const target: RequestTarget =
    endpoint === "model-router"
      ? { kind: "model-router" }
      : { kind: "provider", provider: endpoint };
  const example = buildCurlExample({
    connectionBaseUrl,
    target,
    keyType: credential,
    keyValue:
      credential === "standard"
        ? "$ARCHESTRA_LLM_VIRTUAL_KEY"
        : "$ARCHESTRA_OAUTH_TOKEN",
    model: pool.name,
  });

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={ready ? `${pool.name} is ready` : `Connect to ${pool.name}`}
      description={`Clients ask for ${pool.name} on any of these endpoints. Nothing else changes for them.`}
      size="large"
      className="max-w-4xl"
    >
      <DialogBody className="space-y-5">
        <ChoiceCards
          label="Endpoint"
          choices={ENDPOINTS}
          value={endpoint}
          onChange={setEndpoint}
          columns="sm:grid-cols-3"
        />
        <ChoiceCards
          label="Sign in with"
          choices={CREDENTIALS}
          value={credential}
          onChange={setCredential}
          columns="sm:grid-cols-2"
        />
        <div className="space-y-2">
          <Label>Base URL</Label>
          <code className="block rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all">
            {getProxyBaseUrl(connectionBaseUrl, target)}
          </code>
        </div>
        {endpoint === "anthropic" ? <AnthropicNotice pool={pool} /> : null}
        {example ? <CodeExample language="curl" code={example} /> : null}
      </DialogBody>
      <DialogStickyFooter className="mt-0">
        <DialogCancelButton>Close</DialogCancelButton>
      </DialogStickyFooter>
    </FormDialog>
  );
}

/** Claude Code assumes a 200k context window for a model name it doesn't know. */
function AnthropicNotice({ pool }: { pool: ConnectablePool }) {
  if (pool.name.toLowerCase().startsWith("claude")) return null;
  return (
    <InlineNotice variant="info">
      <Info />
      <span className="font-medium">Set Claude Code's context window</span>
      <InlineNoticeText>
        Set CLAUDE_CODE_MAX_CONTEXT_TOKENS to the smallest context window among
        the members, since Claude Code doesn't know {pool.name}.
      </InlineNoticeText>
    </InlineNotice>
  );
}

type Choice<T extends string> = {
  value: T;
  label: string;
  description: string;
  icon: LucideIcon;
};

function ChoiceCards<T extends string>({
  label,
  choices,
  value,
  onChange,
  columns,
}: {
  label: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  columns: string;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <RadioGroup
        aria-label={label}
        value={value}
        onValueChange={(next) => onChange(next as T)}
        className={cn("grid gap-2", columns)}
      >
        {choices.map((choice) => (
          <Label
            key={choice.value}
            htmlFor={`${id}-${choice.value}`}
            className={cn(
              "flex cursor-pointer flex-col items-start gap-1 rounded-md p-3 font-normal",
              radioCardClass({ checked: value === choice.value }),
            )}
          >
            <RadioGroupItem
              className="sr-only"
              id={`${id}-${choice.value}`}
              value={choice.value}
            />
            <span className="flex items-center gap-2 text-sm font-medium">
              <choice.icon className="size-4" aria-hidden="true" />
              <span>{choice.label}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {choice.description}
            </span>
          </Label>
        ))}
      </RadioGroup>
    </div>
  );
}
