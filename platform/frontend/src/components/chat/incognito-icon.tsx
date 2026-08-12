import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The incognito-chat mark: a lock. The single source for every incognito
 * affordance (sidebar rows, composer toggle, search palette) so the visual
 * stays consistent. Inherits currentColor, so it needs no per-theme variants.
 */
export function IncognitoIcon({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-block shrink-0", className)}>
      <Lock
        role="img"
        aria-label="Incognito chat"
        className="block size-full"
      />
    </span>
  );
}
