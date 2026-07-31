import Link from "next/link";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

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
  const docsUrl = getFrontendDocsUrl("platform-agent-triggers-email");
  return (
    <p className={className}>
      Email invocation of Agents is not configured for your organization.
      {docsUrl ? (
        <>
          <span>{" See the "}</span>
          <ExternalDocsLink
            href={docsUrl}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            setup guide
          </ExternalDocsLink>
          <span>{" for supported email providers and configuration."}</span>
        </>
      ) : (
        <span>
          {
            " Supported email providers and configuration are managed by your administrator."
          }
        </span>
      )}
    </p>
  );
}

export function AgentEmailDisabledMessage({
  className = "text-sm text-muted-foreground",
}: EmailNotConfiguredMessageProps) {
  return (
    <p className={className}>
      Email invocation is not enabled for this agent. Enable it in the{" "}
      <Link
        href="/messaging-channels/email"
        className="text-primary hover:underline"
      >
        agent trigger settings
      </Link>{" "}
      to allow triggering via email.
    </p>
  );
}
