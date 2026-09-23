import { CircleHelp } from "lucide-react";
import Link from "next/link";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { GithubSyncNotice } from "./_parts/github-sync-notice";
import { GuardrailsDeploymentToggle } from "./_parts/guardrails-deployment-toggle";
import { PolicyChatStarter } from "./_parts/policy-chat-starter";

export default function OpenAppaPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <GuardrailsDeploymentToggle />
        <GithubSyncNotice />
        <InlineNotice variant="warning">
          <CircleHelp />
          <span className="font-medium">Using Claude Code?</span>
          <InlineNoticeText>
            Configure policies here, then install the client integration from{" "}
            <Link href="/plugins" className="underline underline-offset-4">
              Plugins
            </Link>
            .
          </InlineNoticeText>
        </InlineNotice>
      </div>
      <PolicyChatStarter />
    </div>
  );
}
