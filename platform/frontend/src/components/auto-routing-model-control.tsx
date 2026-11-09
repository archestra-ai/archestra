"use client";

import { Info, Shuffle } from "lucide-react";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
              offer.kind !== "available" && "text-muted-foreground",
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
 * Stands in for the model picker while the request asks for an auto router:
 * its name, or a choice between the routers the credential can call, with a
 * link to configure auto routing for viewers who can.
 */
export function AutoModelField({
  id,
  names,
  value,
  onValueChange,
}: {
  id: string;
  names: string[];
  value: string;
  onValueChange: (name: string) => void;
}) {
  const { data: canConfigure = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  if (names.length > 1) {
    return (
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} className="w-full font-mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {names.map((name) => (
            <SelectItem key={name} value={name} className="font-mono">
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <div
      id={id}
      className="flex h-9 w-full items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm"
    >
      <Shuffle className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="font-mono">{value}</span>
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

/** Under the field, when auto routing is on: why the request can't use it. */
export function AutoRoutingUnavailableHint({
  offer,
}: {
  offer: AutoRoutingOffer;
}) {
  const providerCatalog = useModelProviderCatalog();
  if (offer.kind === "no-shared-endpoint") {
    return (
      <p className="text-xs text-muted-foreground">
        Auto routing is on, but its models don't share an API endpoint, so no
        request can use it.
      </p>
    );
  }
  if (offer.kind === "unassigned") {
    return (
      <p className="text-xs text-muted-foreground">
        This key has no auto router. Add one in the key's settings to request
        it.
      </p>
    );
  }
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
