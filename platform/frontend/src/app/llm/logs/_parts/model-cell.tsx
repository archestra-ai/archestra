"use client";

import type { SupportedProvider } from "@archestra/shared";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  describeModelOrigin,
  isFreeTierModel,
  type LogSession,
  shortModelName,
} from "./logs-table-format";
import { MakerDisc } from "./maker-disc";

/**
 * The session's model by the name people use for it, behind its maker's logo
 * (one logo per distinct maker when a session used several).
 */
export function ModelCell({
  session,
  providerLabel,
}: {
  session: LogSession;
  /** The organization's name for a provider, from the provider catalog. */
  providerLabel: (provider: SupportedProvider) => string;
}) {
  const models = session.models ?? [];
  if (models.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const entries = models.map((id) => {
    const origin = describeModelOrigin({
      model: id,
      interactionType: session.lastInteractionType,
    });
    return {
      id,
      name: shortModelName(id),
      provider: origin.kind === "unknown" ? null : origin.provider,
      vendor:
        origin.kind === "aggregator"
          ? providerLabel(origin.provider)
          : origin.name,
    };
  });
  const [first, ...rest] = entries;
  const logos = Array.from(
    new Map(
      entries.map((entry) => [entry.provider ?? entry.vendor, entry]),
    ).values(),
  ).slice(0, 3);
  const secondLine =
    rest.length > 0
      ? `+ ${rest.length} more model${rest.length > 1 ? "s" : ""}`
      : isFreeTierModel(first.id)
        ? `${first.vendor} · free tier`
        : first.vendor;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="flex w-full min-w-0 cursor-default items-center gap-2 text-left">
          {/* The second line already names the maker. */}
          <span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
            {logos.map((entry) => (
              <MakerDisc
                key={entry.provider ?? entry.vendor}
                provider={entry.provider}
                vendor={entry.vendor}
              />
            ))}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm leading-5" title={first.id}>
              {first.name}
            </span>
            <span className="block h-4 truncate text-xs leading-4 text-muted-foreground">
              {secondLine}
            </span>
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="px-2 py-1.5">
        <ul className="space-y-1">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2">
              <MakerDisc
                provider={entry.provider}
                vendor={entry.vendor}
                ring={false}
              />
              <span className="font-medium">{entry.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {entry.id}
              </span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
