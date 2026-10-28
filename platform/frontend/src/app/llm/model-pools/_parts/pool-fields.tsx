"use client";

import { DocsPage } from "@archestra/shared";
import { CircleHelp, TriangleAlert } from "lucide-react";
import { Controller } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
import type { PoolForm, PoolOptions } from "./pool-form";

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

/** What happens when a member fails, in one line, with the rules in the docs. */
export function FailoverNote() {
  return (
    <p className="text-xs text-muted-foreground">
      <span>
        A member that answers 429, 5xx or times out is skipped and cools down
        for up to 60 s.
      </span>{" "}
      <ExternalDocsLink
        href={getFrontendDocsUrl(
          DocsPage.PlatformLlmProxyModelPools,
          "how-failover-works",
        )}
        showIcon={false}
        className="underline"
      >
        How failover works
      </ExternalDocsLink>
    </p>
  );
}
