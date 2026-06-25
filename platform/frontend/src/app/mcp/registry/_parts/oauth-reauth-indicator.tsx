import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function formatFailedAt(failedAt: string | null): string | null {
  if (!failedAt) {
    return null;
  }
  const date = new Date(failedAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function buildDetail(errorMessage: string | null, failedAt: string | null) {
  const reason = errorMessage ?? "authentication expired";
  const failed = formatFailedAt(failedAt);
  return failed ? `${reason} · failed ${failed}` : reason;
}

/**
 * Needs-reauthentication state for an OAuth connection. The sanitized reason and
 * failure date are always visible; `onActivate` adds the re-authenticate control
 * only when the caller is permitted to re-authenticate.
 */
export function OAuthReauthIndicator({
  errorMessage,
  failedAt,
  onActivate,
  className,
}: {
  errorMessage: string | null;
  failedAt: string | null;
  onActivate?: () => void;
  className?: string;
}) {
  const detail = buildDetail(errorMessage, failedAt);

  return (
    <span
      className={cn(
        "inline-flex max-w-[240px] flex-wrap items-start gap-x-1 gap-y-0.5 text-xs text-amber-600",
        className,
      )}
      data-testid="oauth-reauth-state"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        Needs re-authentication · {detail}
      </span>
      {onActivate && (
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onActivate}
          className="h-auto shrink-0 px-0 text-xs text-amber-700 underline hover:text-amber-800"
          data-testid="oauth-reauth-action"
        >
          Re-authenticate
        </Button>
      )}
    </span>
  );
}
