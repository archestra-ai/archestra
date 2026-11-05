"use client";

import { Info, Shuffle } from "lucide-react";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { AutoRoutingOffer } from "@/components/use-auto-routing-offer";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils/tailwind";

const AUTO_ROUTING_URL = "/llm/auto-routing";
const SWITCH_ID = "request-example-auto-routing";

/**
 * Sits on the model field's label row: the "Use auto routing" switch, or a
 * link to set auto routing up when it's off. Renders nothing for "none".
 */
export function AutoRoutingLabelAction({
  offer,
  checked,
  onCheckedChange,
}: {
  offer: AutoRoutingOffer;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  if (offer.kind === "none") return null;
  return (
    <div className="flex items-center gap-2">
      <AutoRoutingInfo />
      {offer.kind === "setup" ? (
        // Styled like the other in-page links, such as "How pools work".
        <Link
          href={AUTO_ROUTING_URL}
          className="text-xs text-primary underline"
        >
          Set up auto routing
        </Link>
      ) : (
        <>
          <Label
            htmlFor={SWITCH_ID}
            className={cn(
              "text-xs font-normal",
              offer.kind === "unreachable" && "text-muted-foreground",
            )}
          >
            Use auto routing
          </Label>
          <Switch
            id={SWITCH_ID}
            checked={checked}
            disabled={offer.kind !== "available"}
            onCheckedChange={onCheckedChange}
          />
        </>
      )}
    </div>
  );
}

/**
 * Stands in for the model picker while the request asks for `auto`, with a
 * link to configure auto routing for viewers who can.
 */
export function AutoModelField({ id }: { id: string }) {
  const { data: canConfigure = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  return (
    <div
      id={id}
      className="flex h-9 w-full items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm"
    >
      <Shuffle className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="font-mono">auto</span>
      {canConfigure && (
        <Link
          href={AUTO_ROUTING_URL}
          className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Configure auto routing
        </Link>
      )}
    </div>
  );
}

/** Under the field, when auto routing is on: why this credential can't use it. */
export function AutoRoutingUnreachableHint({
  offer,
}: {
  offer: AutoRoutingOffer;
}) {
  const providerCatalog = useModelProviderCatalog();
  if (offer.kind !== "unreachable") return null;
  const tiers = offer.missing.map(({ tier }) => tier).join(" or ");
  const providers = [...new Set(offer.missing.map((m) => m.provider))]
    .map((provider) => providerCatalog.label(provider))
    .join(", ");
  return (
    <p className="text-xs text-muted-foreground">
      Auto routing is on, but this credential can't reach its {tiers}{" "}
      {offer.missing.length === 1 ? "model" : "models"}. It needs access to{" "}
      {providers}.
    </p>
  );
}

function AutoRoutingInfo() {
  const appName = useAppName();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label="What is auto routing?"
          className="text-muted-foreground hover:text-foreground"
        >
          <Info className="size-3.5" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        Lets {appName} choose a fast, normal or smart model for each
        conversation, based on what its first message needs.
      </TooltipContent>
    </Tooltip>
  );
}
