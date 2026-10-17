import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { cn } from "@/lib/utils/tailwind";

/**
 * A read that failed, offered with a way to try again. Kept distinct from the
 * "no such version" copy on purpose: a transport failure supports no claim
 * about what the history holds, so it must not be phrased as one.
 */
export function LoadFailure({
  message,
  onRetry,
  variant = "error",
  className,
}: {
  message: string;
  onRetry: () => void;
  /** `warning` when the failure leaves the rest of the pane readable. */
  variant?: "error" | "warning";
  className?: string;
}) {
  return (
    <InlineNotice variant={variant} className={cn("w-full", className)}>
      <TriangleAlert />
      <InlineNoticeText>{message}</InlineNoticeText>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="ml-auto"
        onClick={onRetry}
      >
        Retry
      </Button>
    </InlineNotice>
  );
}
