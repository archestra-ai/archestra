"use client";

import {
  E2eTestId,
  isModelRouterSupportedProvider,
  providerSupportsChat,
  requiresPerplexityAgentApi,
  type SupportedProvider,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { AlertTriangle, Check, Copy, Plug, Waypoints } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { PROVIDER_ORIGINAL_URLS } from "@/app/connection/proxy-client-instructions";
import { terminalCodeClass } from "@/components/terminal-surface";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildCurlExample,
  getProviderAuthHeader,
  getProxyBaseUrl,
  providerKeyEnvVar,
  type RequestTarget,
} from "@/components/virtual-key-request-example";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmModels, useModelsWithApiKeys } from "@/lib/llm-models.query";
import { cn } from "@/lib/utils";

type Endpoint = "model-router" | "provider";

/**
 * Post-create handoff for a virtual key: copy the key, pick an endpoint the key
 * actually works on, then copy a curl request that runs as-is.
 */
export function VirtualKeyConnectionGuide({
  keyValue,
  keyType,
  mappedProviderKeys,
  connectionBaseUrl,
  name,
  expiration,
  visibleTo,
}: {
  keyValue: string;
  keyType: "standard" | "passthrough";
  /** The provider keys a standard key maps to (empty for passthrough). */
  mappedProviderKeys: Array<{
    provider: SupportedProvider;
    providerApiKeyId: string;
  }>;
  connectionBaseUrl: string;
  name: string;
  expiration: string;
  /** Who can use the key; omitted for passthrough keys (always personal). */
  visibleTo: string | null;
}) {
  const appName = useAppName();
  const providerCatalog = useModelProviderCatalog();
  const isPassthrough = keyType === "passthrough";

  // A standard key only works on routes for the providers it maps; a
  // passthrough key carries no provider key, so any chat provider route works.
  const providers = useMemo(
    () =>
      isPassthrough
        ? providerCatalog.visibleIds.filter(providerSupportsChat)
        : mappedProviderKeys.map((mapping) => mapping.provider),
    [isPassthrough, providerCatalog.visibleIds, mappedProviderKeys],
  );
  const routerProviders = isPassthrough
    ? []
    : providers.filter(isModelRouterSupportedProvider);
  const routerAvailable = routerProviders.length > 0;

  const [endpoint, setEndpoint] = useState<Endpoint>(
    routerAvailable ? "model-router" : "provider",
  );
  const [pickedProvider, setPickedProvider] =
    useState<SupportedProvider | null>(null);
  const provider =
    pickedProvider && providers.includes(pickedProvider)
      ? pickedProvider
      : providers[0];

  const target: RequestTarget =
    endpoint === "model-router"
      ? { kind: "model-router" }
      : { kind: "provider", provider };
  const baseUrl = getProxyBaseUrl(connectionBaseUrl, target);

  return (
    <ol>
      <Step number={1} title="Copy your key">
        <p className="text-sm text-muted-foreground">
          {isPassthrough
            ? "Send it alongside your own provider key so requests are attributed to you."
            : "Use it anywhere you would use a provider API key."}
        </p>
        {/* Same no-wrap layout as agent-form's notices: the icon stays beside
            the text instead of wrapping onto its own line. */}
        <InlineNotice className="flex-nowrap items-start">
          <AlertTriangle className="mt-px" />
          <InlineNoticeText>
            This is the only time the full key is shown. Store it in a secret
            manager or your app&apos;s environment.
          </InlineNoticeText>
        </InlineNotice>
        <CopyField
          value={keyValue}
          copyLabel="Copy key"
          primary
          data-testid={E2eTestId.VirtualKeyValue}
        />
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <KeyFact label="Name" value={name} />
          <KeyFact label="Expires" value={expiration} />
          {visibleTo && <KeyFact label="Visible to" value={visibleTo} />}
        </dl>
      </Step>

      <Step number={2} title={`Point your app at ${appName}`}>
        <p className="text-sm text-muted-foreground">
          {isPassthrough
            ? "Passthrough keys work on the native provider routes."
            : `Choose how your app talks to ${appName}.`}
        </p>
        <EndpointPicker
          value={endpoint}
          onChange={setEndpoint}
          routerAvailable={routerAvailable}
        />
        {endpoint === "provider" && providers.length > 1 && (
          <Select
            value={provider}
            onValueChange={(value) =>
              setPickedProvider(value as SupportedProvider)
            }
          >
            <SelectTrigger aria-label="Provider" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p} value={p}>
                  {providerCatalog.label(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <CopyField label="Base URL" value={baseUrl} />
        <EndpointDetails
          target={target}
          isPassthrough={isPassthrough}
          providerLabel={providerCatalog.label(provider)}
        />
      </Step>

      <Step number={3} title="Make your first request">
        <RequestExample
          // Remount on target change so the model resets to that target's
          // recommended model instead of keeping one it can't serve.
          key={endpoint === "model-router" ? endpoint : provider}
          connectionBaseUrl={connectionBaseUrl}
          target={target}
          keyType={keyType}
          keyValue={keyValue}
          routerProviders={routerProviders}
          mappedProviderKeys={mappedProviderKeys}
        />
        {isPassthrough && (
          <p className="text-xs text-muted-foreground">
            Using Claude Code or Claude Desktop? The{" "}
            <Link
              href="/connection"
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
            >
              Connection page
            </Link>{" "}
            sets this header up for you.
          </p>
        )}
      </Step>
    </ol>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    // The rail runs from under each marker to the next one.
    <li className="relative flex gap-3.5 pb-7 before:absolute before:top-7 before:bottom-1 before:left-3 before:w-px before:bg-border last:pb-0 last:before:hidden">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 bg-background text-xs font-semibold text-muted-foreground tabular-nums">
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <h3 className="text-sm leading-6 font-semibold">{title}</h3>
        {children}
      </div>
    </li>
  );
}

function EndpointPicker({
  value,
  onChange,
  routerAvailable,
}: {
  value: Endpoint;
  onChange: (value: Endpoint) => void;
  routerAvailable: boolean;
}) {
  const id = useId();
  const options = [
    {
      value: "model-router" as const,
      label: "Model Router",
      description: "One OpenAI-compatible endpoint for all providers",
      icon: Waypoints,
      disabled: !routerAvailable,
    },
    {
      value: "provider" as const,
      label: "Native provider API",
      description: "Keep your provider's SDK, change only the base URL",
      icon: Plug,
      disabled: false,
    },
  ];
  return (
    <RadioGroup
      aria-label="Endpoint"
      value={value}
      onValueChange={(next) => onChange(next as Endpoint)}
      className="grid gap-2 sm:grid-cols-2"
    >
      {options.map((option) => (
        <Label
          key={option.value}
          htmlFor={`${id}-${option.value}`}
          className={cn(
            "flex cursor-pointer flex-col items-start gap-1 rounded-md border p-3 font-normal transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            value === option.value
              ? "border-primary bg-primary/10"
              : "hover:bg-muted/50",
          )}
        >
          <RadioGroupItem
            className="sr-only"
            id={`${id}-${option.value}`}
            value={option.value}
            disabled={option.disabled}
          />
          <span className="flex items-center gap-2 text-sm font-medium">
            <option.icon className="size-4" />
            {option.label}
          </span>
          <span className="text-xs text-muted-foreground">
            {option.description}
          </span>
        </Label>
      ))}
    </RadioGroup>
  );
}

function EndpointDetails({
  target,
  isPassthrough,
  providerLabel,
}: {
  target: RequestTarget;
  isPassthrough: boolean;
  providerLabel: string;
}) {
  if (target.kind === "model-router") {
    return (
      <p className="text-xs text-muted-foreground">
        Use any OpenAI-compatible client with your virtual key as the API key.
        Pick the provider per request with a prefixed model name, like{" "}
        <InlineCode>openai:gpt-5.4</InlineCode>.
      </p>
    );
  }
  const authHeader = getProviderAuthHeader(target.provider);
  const originalUrl = (
    PROVIDER_ORIGINAL_URLS as Partial<Record<SupportedProvider, string>>
  )[target.provider];
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {originalUrl && (
        <p>
          Replaces <s>{originalUrl}</s>
        </p>
      )}
      {isPassthrough ? (
        <p>
          Keep sending your own {providerLabel} key
          {authHeader ? (
            <span>
              {" "}
              as <InlineCode>{authHeader}</InlineCode>
            </span>
          ) : null}
          <span>
            , and add your virtual key in the{" "}
            <InlineCode>{VIRTUAL_KEY_HEADER}</InlineCode> header.
          </span>
        </p>
      ) : (
        <p>
          Your virtual key replaces your {providerLabel} API key
          {authHeader ? (
            <span>
              {" "}
              (sent as <InlineCode>{authHeader}</InlineCode>)
            </span>
          ) : null}
          <span>.</span>
        </p>
      )}
    </div>
  );
}

function RequestExample({
  connectionBaseUrl,
  target,
  keyType,
  keyValue,
  routerProviders,
  mappedProviderKeys,
}: {
  connectionBaseUrl: string;
  target: RequestTarget;
  keyType: "standard" | "passthrough";
  keyValue: string;
  routerProviders: SupportedProvider[];
  mappedProviderKeys: Array<{
    provider: SupportedProvider;
    providerApiKeyId: string;
  }>;
}) {
  const providerCatalog = useModelProviderCatalog();
  const isPassthrough = keyType === "passthrough";
  const { data: passthroughModels, isPending: passthroughModelsPending } =
    useLlmModels({ enabled: isPassthrough });
  const { data: linkedModels, isPending: linkedModelsPending } =
    useModelsWithApiKeys({ enabled: !isPassthrough });
  const isPending = isPassthrough
    ? passthroughModelsPending
    : linkedModelsPending;

  // The general catalog spans every key the creator can access. For standard
  // keys, use the model-to-key links instead so this example only offers models
  // served by the provider keys mapped to the newly created virtual key.
  const mappedKeyIds = new Set(
    mappedProviderKeys.map((mapping) => mapping.providerApiKeyId),
  );
  const candidates = isPassthrough
    ? (passthroughModels ?? []).map((model) => ({
        id: model.id,
        provider: model.provider,
        isBest: model.isBest,
        supportedEndpoints: model.capabilities?.supportedEndpoints,
      }))
    : (linkedModels ?? [])
        .filter((model) =>
          model.apiKeys.some((key) => mappedKeyIds.has(key.id)),
        )
        .filter(
          (model) =>
            !model.ignored &&
            model.embeddingDimensions === null &&
            (!model.inputModalities ||
              model.inputModalities.includes("text")) &&
            (!model.outputModalities ||
              model.outputModalities.includes("text")),
        )
        .map((model) => ({
          id: model.modelId,
          provider: model.provider,
          isBest: model.isBest,
          supportedEndpoints: Array.isArray(model.supportedEndpoints)
            ? model.supportedEndpoints.filter(
                (endpoint): endpoint is string => typeof endpoint === "string",
              )
            : null,
        }));
  const modelOptions = candidates
    .filter((model) =>
      target.kind === "model-router"
        ? routerProviders.includes(model.provider) &&
          // The router does not have a native Perplexity Agent API adapter.
          !(
            model.provider === "perplexity" &&
            requiresPerplexityAgentApi(model.id)
          )
        : model.provider === target.provider,
    )
    .sort((a, b) => Number(b.isBest ?? false) - Number(a.isBest ?? false))
    .map((model) => ({
      value:
        target.kind === "model-router"
          ? `${model.provider}:${model.id}`
          : model.id,
      supportedEndpoints: model.supportedEndpoints,
    }));

  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const model =
    pickedModel && modelOptions.some((option) => option.value === pickedModel)
      ? pickedModel
      : modelOptions[0]?.value;
  const selectedModel = modelOptions.find((option) => option.value === model);

  const example =
    model &&
    buildCurlExample({
      connectionBaseUrl,
      target,
      keyType,
      keyValue,
      model,
      supportedEndpoints: selectedModel?.supportedEndpoints,
    });
  const providerLabel =
    target.kind === "provider" ? providerCatalog.label(target.provider) : null;

  if (!isPending && modelOptions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No runnable model example is available for this key and endpoint yet.
      </p>
    );
  }

  if (!example) {
    return (
      <p className="text-sm text-muted-foreground">
        {isPending
          ? "Loading models…"
          : `No example for ${providerLabel} yet. Point your ${providerLabel} SDK at the base URL above.`}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {isPassthrough && target.kind === "provider" ? (
          <span>
            Your key, base URL and model are filled in. Your {providerLabel} key
            is read from{" "}
            <InlineCode>{providerKeyEnvVar(target.provider)}</InlineCode>.
          </span>
        ) : (
          <span>Your key, base URL and model are filled in. Run it as is.</span>
        )}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="virtual-key-example-model">Model</Label>
        <Select
          value={model ?? ""}
          onValueChange={setPickedModel}
          disabled={isPending || modelOptions.length === 0}
        >
          <SelectTrigger
            id="virtual-key-example-model"
            className="w-full sm:w-80"
          >
            <SelectValue
              placeholder={
                isPending ? "Loading models…" : "No models found for this key"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isPassthrough && (
          <p className="text-xs text-muted-foreground">
            From your organization&apos;s model catalog. Your own key may have
            access to different models.
          </p>
        )}
      </div>
      <CodeExample language="cURL" code={example} />
    </div>
  );
}

/** A single-line value with its copy button on the same row. */
function KeyFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt>{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

function CopyField({
  label,
  value,
  copyLabel = label ? `Copy ${label.toLowerCase()}` : "Copy",
  primary = false,
  ...props
}: {
  label?: string;
  value: string;
  copyLabel?: string;
  primary?: boolean;
} & React.ComponentProps<"div">) {
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-terminal-edge bg-terminal py-1 pr-1 pl-3"
      {...props}
    >
      {label && (
        <span className="shrink-0 text-xs text-terminal-muted">{label}</span>
      )}
      <code className={cn(terminalCodeClass, "min-w-0 flex-1 break-all")}>
        {value}
      </code>
      <CopyButton value={value} label={copyLabel} primary={primary} />
    </div>
  );
}

/** A multi-line example with a header bar naming the language. */
function CodeExample({ language, code }: { language: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-terminal-edge bg-terminal">
      <div className="flex items-center justify-between border-b border-terminal-edge py-1 pr-1 pl-3">
        <span className="text-xs text-terminal-muted">{language}</span>
        <CopyButton value={code} label="Copy example" />
      </div>
      <pre
        className={cn(
          terminalCodeClass,
          "m-0 max-h-[360px] overflow-auto px-3.5 py-3 text-[12.5px]",
        )}
      >
        <HighlightedCurl code={code} />
      </pre>
    </div>
  );
}

function CopyButton({
  value,
  label,
  primary = false,
}: {
  value: string;
  label: string;
  primary?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="icon"
      variant={primary ? "default" : "outline"}
      aria-label={copied ? "Copied" : label}
      className="size-7 shrink-0"
      onClick={async () => {
        await copyToClipboard(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/** Colors curl's command/flags and quoted strings; everything else is plain. */
function HighlightedCurl({ code }: { code: string }) {
  return code.split("\n").map((line, lineIndex) => {
    const [, indent, command, rest] =
      line.match(/^(\s*)(curl|-H|-d)?(.*)$/) ?? [];
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reorder
      <span key={lineIndex}>
        <span>{indent}</span>
        {command && <span className="text-primary">{command}</span>}
        {rest.split(/("[^"]*")/).map((part, partIndex) =>
          part.startsWith('"') ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
            <span key={partIndex} className="text-terminal-success">
              {part}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
            <span key={partIndex}>{part}</span>
          ),
        )}
        <span>{"\n"}</span>
      </span>
    );
  });
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground">
      {children}
    </code>
  );
}
