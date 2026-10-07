import { KeyRound } from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import type { RuntimeCredentialDefinition } from "@/lib/runtime-credentials.query";
import { cn } from "@/lib/utils/tailwind";

export function RuntimeCredentialIcon({
  icon,
  className,
  size = 20,
}: {
  icon: string | null;
  className?: string;
  size?: number;
}) {
  if (!icon) return <KeyRound className={cn("size-5 shrink-0", className)} />;
  return <AgentIcon icon={icon} className={className} size={size} />;
}

/** A definition's own icon, or GitHub's for a GitHub App credential that has none. */
export function runtimeCredentialIconOf(
  definition: Pick<RuntimeCredentialDefinition, "icon" | "kind">,
): string | null {
  return (
    definition.icon ??
    (definition.kind === "github_app" || definition.kind === "github_app_user"
      ? "logo:github"
      : null)
  );
}
