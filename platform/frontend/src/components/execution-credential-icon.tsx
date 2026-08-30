import { KeyRound } from "lucide-react";
import { siAnthropic, siGithub } from "simple-icons";
import { AgentIcon } from "@/components/agent-icon";
import { cn } from "@/lib/utils";

export function ExecutionCredentialIcon({
  icon,
  className,
}: {
  icon: string | null;
  className?: string;
}) {
  const service = BUILT_IN_SERVICE_ICONS[icon ?? ""];
  if (service) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={cn("size-5 shrink-0", className)}
        fill="currentColor"
      >
        <path d={service.path} />
      </svg>
    );
  }
  if (icon) return <AgentIcon icon={icon} className={className} size={20} />;
  return <KeyRound className={cn("size-5 shrink-0", className)} />;
}

const BUILT_IN_SERVICE_ICONS: Record<string, { path: string }> = {
  "logo:github": siGithub,
  "logo:anthropic": siAnthropic,
};
