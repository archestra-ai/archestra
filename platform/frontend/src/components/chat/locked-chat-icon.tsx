import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The locked-chat mark: a lock. The single source for every locked-chat
 * affordance (sidebar rows, composer toggle, search palette) so the visual
 * stays consistent. Inherits currentColor, so it needs no per-theme variants.
 *
 * Renders the bare svg (no wrapper element): container rules that size row
 * icons — e.g. cmdk's `[&_svg]` selectors — must see this icon exactly like
 * its lucide siblings, or it ends up a different size than the icons beside
 * it. A wrapper whose inner svg was sized with `size-full` did exactly that.
 */
export function LockedChatIcon({ className }: { className?: string }) {
  return (
    <Lock
      role="img"
      aria-label="Locked chat"
      className={cn("shrink-0", className)}
    />
  );
}
