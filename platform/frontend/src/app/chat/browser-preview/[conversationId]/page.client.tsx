"use client";

import { BrowserPreviewContent } from "@/components/chat/browser-preview-content";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useOrganization } from "@/lib/organization.query";

interface BrowserPreviewClientProps {
  /** Initial conversationId from URL, but popup will follow active conversation */
  initialConversationId: string;
}

export function BrowserPreviewClient({
  initialConversationId,
}: BrowserPreviewClientProps) {
  const { data: organization } = useOrganization(true, {
    fresh: true,
    refetchInterval: 5000,
  });
  if (organization?.playwrightMcpEnabled !== true)
    return (
      <InlineNotice variant="neutral">
        <InlineNoticeText>
          The built-in browser is unavailable.
        </InlineNoticeText>
      </InlineNotice>
    );
  return (
    <div className="h-app-viewport w-full flex flex-col">
      <BrowserPreviewContent
        conversationId={initialConversationId}
        isActive={true}
        isPopup={true}
        className="flex-1"
      />
    </div>
  );
}
