"use client";

import { DocsPage } from "@archestra/shared";
import { CircleHelp, TriangleAlert } from "lucide-react";
import { Controller } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { suggestModelId } from "./model-name";
import {
  isValidSeconds,
  MAX_SECONDS,
  type PoolForm,
  type PoolOptions,
  type PoolTiming,
} from "./pool-form";

export function ModelNameField({
  form,
  options,
  disabled,
  taken,
}: {
  form: PoolForm;
  options: PoolOptions;
  disabled: boolean;
  taken: boolean;
}) {
  return (
    <div className="space-y-2">
      <span className="flex items-center gap-1.5">
        <Label htmlFor="pool-name">Model name</Label>
        <HelpTip topic="Model name">
          The model name clients ask for, e.g. in Claude Code or the OpenAI SDK.
        </HelpTip>
      </span>
      <Controller
        control={form.control}
        name="name"
        render={({ field }) => (
          <SearchableSelect
            id="pool-name"
            value={field.value}
            onValueChange={(value) => {
              field.onChange(value);
              // Members still on the old name follow the new one.
              form.setValue(
                "members",
                form.getValues("members").map((member) =>
                  !member.modelId || member.modelId === field.value
                    ? {
                        ...member,
                        modelId: suggestModelId(
                          value,
                          options.keysById.get(member.providerApiKeyId)
                            ?.provider,
                          options.modelIdsByKey.get(member.providerApiKeyId),
                        ),
                      }
                    : member,
                ),
                { shouldDirty: true },
              );
            }}
            disabled={disabled}
            placeholder="e.g. glm-5"
            ariaLabel="Model name"
            searchPlaceholder="Search or type a model name"
            allowCustom
            className="w-full font-mono"
            items={options.modelNames.map((value) => ({ value, label: value }))}
          />
        )}
      />
      {taken ? (
        <InlineNotice>
          <TriangleAlert />
          <span className="font-medium">This name already has a pool</span>
          <InlineNoticeText>Add the members there instead.</InlineNoticeText>
        </InlineNotice>
      ) : null}
    </div>
  );
}

/** A "?" beside a label that explains it in one or two sentences. */
export function HelpTip({
  topic,
  children,
}: {
  topic: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`About ${topic}`}
          className="inline-flex text-muted-foreground hover:text-foreground"
          onFocus={(event) => {
            // A dialog focuses its first control on open; only keyboard
            // focus should open the tip.
            if (!event.currentTarget.matches(":focus-visible")) {
              event.preventDefault();
            }
          }}
        >
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{children}</TooltipContent>
    </Tooltip>
  );
}

/** Failover timing a pool uses when its own is blank. */
const DEFAULT_STREAM_TIMEOUT_SECONDS = 30;
const DEFAULT_COOLDOWN_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * When a member is skipped and for how long, named as LiteLLM names them.
 * Blank keeps the default.
 */
export function TimeoutFields({
  form,
  disabled,
}: {
  form: PoolForm;
  disabled: boolean;
}) {
  return (
    <div className="@container space-y-2">
      <div className="space-y-0.5">
        <Label>Timeouts and cooldown</Label>
        <FieldDescription>
          <span>
            When a member is skipped, and for how long. The last member is never
            timed out.
          </span>{" "}
          <ExternalDocsLink
            href={getFrontendDocsUrl(
              DocsPage.PlatformLlmProxyModelPools,
              "when-a-member-fails",
            )}
            showIcon={false}
            className="underline"
          >
            How failover works
          </ExternalDocsLink>
        </FieldDescription>
      </div>
      <div className="grid gap-3 @lg:grid-cols-3">
        <SecondsField
          form={form}
          name="streamTimeoutSeconds"
          label="Stream timeout"
          placeholder={String(DEFAULT_STREAM_TIMEOUT_SECONDS)}
          disabled={disabled}
        >
          Seconds to wait for the first chunk of a streamed response before
          moving to the next member.
        </SecondsField>
        <SecondsField
          form={form}
          name="timeoutSeconds"
          label="Timeout"
          placeholder="Auto"
          disabled={disabled}
        >
          Seconds for a full non-streamed response. Auto is 3 min plus 1 s per
          20 tokens the request lets the model write, up to 30 min.
        </SecondsField>
        <SecondsField
          form={form}
          name="cooldownSeconds"
          label="Cooldown time"
          placeholder={String(DEFAULT_COOLDOWN_SECONDS)}
          disabled={disabled}
        >
          Minimum seconds a failed member is skipped by later requests. A longer
          Retry-After header extends it, up to {MAX_RETRY_AFTER_SECONDS} s or
          this time if longer.
        </SecondsField>
      </div>
    </div>
  );
}

function SecondsField({
  form,
  name,
  label,
  placeholder,
  disabled,
  children,
}: {
  form: PoolForm;
  name: PoolTiming;
  label: string;
  placeholder: string;
  disabled: boolean;
  /** The help tip. */
  children: React.ReactNode;
}) {
  const id = `pool-${name}`;
  return (
    <div className="space-y-1.5">
      <span className="flex items-center gap-1.5">
        <Label
          htmlFor={id}
          className="text-xs font-normal text-muted-foreground"
        >
          {label}
        </Label>
        <HelpTip topic={label}>
          {children} At most {MAX_SECONDS[name]} s.
        </HelpTip>
      </span>
      <Controller
        control={form.control}
        name={name}
        render={({ field }) => (
          <InputGroup data-disabled={disabled}>
            <InputGroupInput
              id={id}
              inputMode="numeric"
              value={field.value}
              placeholder={placeholder}
              disabled={disabled}
              aria-invalid={!isValidSeconds(name, field.value)}
              onBlur={field.onBlur}
              onChange={(event) =>
                field.onChange(event.target.value.replace(/\D/g, ""))
              }
              className="tabular-nums"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>s</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        )}
      />
    </div>
  );
}
