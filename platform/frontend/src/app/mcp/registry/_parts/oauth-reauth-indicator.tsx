import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Compact needs-reauthentication marker for an OAuth connection on a server
 * card: an alert icon and a short label, nothing more. When `onActivate` is
 * supplied (the caller may re-authenticate the connection), the whole marker is
 * one click target that opens the credential surface, where the detailed reason
 * lives; without it the marker is shown but inert.
 */
export function OAuthReauthIndicator({
  onActivate,
  className,
}: {
  onActivate?: () => void;
  className?: string;
}) {
  const containerClassName = cn(
    "inline-flex items-center gap-1 text-xs text-amber-600",
    className,
  );

  const body = (
    <>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>Needs re-authentication</span>
    </>
  );

  if (!onActivate) {
    return (
      <span className={containerClassName} data-testid="oauth-reauth-state">
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onActivate}
      className={cn(
        containerClassName,
        "cursor-pointer rounded-sm underline-offset-2 hover:text-amber-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500",
      )}
      data-testid="oauth-reauth-state"
      aria-label="Needs re-authentication, open credentials"
    >
      {body}
    </button>
  );
}
