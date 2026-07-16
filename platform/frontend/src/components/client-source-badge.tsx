import type { ClientFamily } from "@archestra/shared";
import { ProviderIcon } from "@/components/provider-icon";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Client-app badge for the LLM logs screens. Every client family shares the
 * same neutral badge styling and is identified by its vendor logo + label
 * (Claude → Anthropic, Codex → OpenAI), mirroring the logs "Client" filter
 * options. `client` comes from `clientForExternalAgentIds`
 * (`@archestra/shared`).
 */
export function ClientSourceBadge({
  client,
  className,
}: {
  client: Pick<ClientFamily, "label" | "provider">;
  className?: string;
}) {
  return (
    <Badge variant="secondary" className={cn("text-xs", className)}>
      <ProviderIcon provider={client.provider} size={12} />
      {client.label}
    </Badge>
  );
}
