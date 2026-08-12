import { AlertTriangle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const LABEL = "Needs re-authentication";

/**
 * Compact needs-reauthentication marker for an OAuth connection on a server
 * card: an alert icon, nothing more. When `onActivate` is supplied (the caller
 * may re-authenticate the connection), the marker is one click target that
 * opens the credential surface, where the detailed reason lives; without it the
 * marker is shown but inert.
 *
 * The label is carried by a tooltip and an sr-only span rather than set inline.
 * The marker shares one card row with the scope badge, the tool and agent
 * counts, the deployment state and the connection avatars, and at the grid's
 * card width there is no room for a five-word string — rendered inline it
 * pushed the row past the card edge on exactly the cards that had something to
 * report.
 */
export function OAuthReauthIndicator({
  onActivate,
  className,
}: {
  onActivate?: () => void;
  className?: string;
}) {
  // amber-800 in light mode: amber-600 measures ~3.1:1 on the card background,
  // below the 4.5:1 minimum for small text (WCAG 1.4.3).
  const containerClassName = cn(
    "inline-flex shrink-0 items-center text-amber-800 dark:text-amber-400",
    className,
  );

  const body = (
    <>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="sr-only">{LABEL}</span>
    </>
  );

  const marker = onActivate ? (
    <button
      type="button"
      onClick={onActivate}
      className={cn(
        containerClassName,
        "cursor-pointer rounded-sm hover:text-amber-900 dark:hover:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500",
      )}
      data-testid="oauth-reauth-state"
      aria-label={`${LABEL}, open credentials`}
    >
      {body}
    </button>
  ) : (
    <span className={containerClassName} data-testid="oauth-reauth-state">
      {body}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{marker}</TooltipTrigger>
      <TooltipContent>{LABEL}</TooltipContent>
    </Tooltip>
  );
}
