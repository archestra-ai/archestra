"use client";

import { Info } from "lucide-react";
import { type ReactNode, useId } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

export function ProviderAccessField({
  current,
  surface,
  automaticCurrent,
  canIncludeFutureProviders = true,
  includeFutureProviders,
  onIncludeFutureProvidersChange,
}: {
  canIncludeFutureProviders?: boolean;
  includeFutureProviders: boolean;
  onIncludeFutureProvidersChange: (value: boolean) => void;
  current: ReactNode;
  automaticCurrent?: ReactNode;
  surface: "create" | "edit" | "connect";
}) {
  const id = useId();
  const automatic = includeFutureProviders;
  const connect = surface === "connect";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">
          {connect
            ? "Providers available to new virtual keys"
            : "Provider access"}
        </p>
        <RadioGroup
          value={automatic ? "future" : "selected"}
          onValueChange={(value) =>
            onIncludeFutureProvidersChange(value === "future")
          }
          aria-label="Provider access"
          className="gap-2"
        >
          <Label
            htmlFor={`${id}-selected`}
            className={cn(
              radioCardClass(),
              "flex cursor-pointer items-start gap-3 rounded-md p-3",
            )}
          >
            <RadioGroupItem
              id={`${id}-selected`}
              value="selected"
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">
                Selected providers
              </span>
              <span className="block text-xs font-normal leading-relaxed text-muted-foreground">
                Choose the providers this virtual key can use. Providers added
                later need to be selected here.
              </span>
            </span>
          </Label>
          <Label
            htmlFor={`${id}-future`}
            className={cn(
              radioCardClass(),
              "flex cursor-pointer items-start gap-3 rounded-md p-3",
            )}
          >
            <RadioGroupItem
              id={`${id}-future`}
              value="future"
              disabled={!canIncludeFutureProviders}
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">
                Current and future providers
              </span>
              <span className="block text-xs font-normal leading-relaxed text-muted-foreground">
                Add a provider later → this virtual key can use it. No new
                virtual key needed.
              </span>
            </span>
          </Label>
        </RadioGroup>
      </div>

      {automatic ? (
        <div className="space-y-3">
          <InlineNotice variant="neutral">
            <Info />
            <InlineNoticeBody>
              <InlineNoticeText>
                Uses each provider’s shared API key marked <PrimaryTerm />.
                Personal and subscription API keys are excluded.
                {connect ? (
                  <span>
                    {" "}
                    New keys from Connect use this setting. Existing keys are
                    unchanged.
                  </span>
                ) : null}
              </InlineNoticeText>
            </InlineNoticeBody>
          </InlineNotice>
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="api-keys">
              <AccordionTrigger className="py-2 hover:no-underline">
                <span className="flex flex-col gap-0.5">
                  <span>API keys</span>
                  <span className="text-[11px] font-normal leading-snug text-muted-foreground">
                    Optional — choose a different API key for an existing
                    provider
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {automaticCurrent ?? current}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      ) : (
        <div className="space-y-3">
          {current}
          {connect ? (
            <p className="text-xs text-muted-foreground">
              New keys from Connect use this setting. Existing keys are
              unchanged.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PrimaryTerm() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          type="button"
          className="cursor-help rounded-sm underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Primary
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs py-2">
        The shared API key chosen as the default for this provider. You can mark
        a key as Primary in Model Providers.
      </TooltipContent>
    </Tooltip>
  );
}
