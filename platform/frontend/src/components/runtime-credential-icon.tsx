import { KeyRound } from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import { cn } from "@/lib/utils";

export function RuntimeCredentialIcon({
  icon,
  className,
}: {
  icon: string | null;
  className?: string;
}) {
  if (!icon) return <KeyRound className={cn("size-5 shrink-0", className)} />;
  return <AgentIcon icon={icon} className={className} size={20} />;
}
