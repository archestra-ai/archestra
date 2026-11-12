"use client";

import { Info } from "lucide-react";
import { PageLayout } from "@/components/page-layout";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";

/** The auto routing pages exist only where the deployment has auto routing on. */
export default function AutoRoutingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const appName = useAppName();
  const enabled = useFeature("autoRoutingEnabled");
  if (enabled === undefined) return null;
  if (enabled) return children;
  return (
    <PageLayout minWidth="phone" title="Auto Routing">
      <InlineNotice variant="neutral">
        <Info />
        <span className="font-medium">Auto routing is off</span>
        <InlineNoticeText>
          This {appName} deployment does not have auto routing enabled.
        </InlineNoticeText>
      </InlineNotice>
    </PageLayout>
  );
}
