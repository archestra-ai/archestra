import { ExternalLink } from "lucide-react";
import Link from "next/link";

interface EmailNotConfiguredMessageProps {
  /** Optional className for the container */
  className?: string;
}

/**
 * Shared component that displays a message when incoming email is not configured
 * at the organization level. Shows a link to documentation with setup instructions.
 *
 * Used in:
 * - Edit Agent dialog (Email Invocation section)
 * - A2A Connection Instructions (Email Invocation section)
 */
export function EmailNotConfiguredMessage({
  className = "text-sm text-muted-foreground",
}: EmailNotConfiguredMessageProps) {
  return (
    <p className={className}>
      Email invocation of Agents is not configured for your organization. See
      the{" "}
      <Link
        href="https://archestra.ai/docs/platform-agents#incoming-email"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-primary hover:underline"
      >
        setup guide
        <ExternalLink className="h-3 w-3" />
      </Link>{" "}
      for supported email providers and configuration.
    </p>
  );
}
