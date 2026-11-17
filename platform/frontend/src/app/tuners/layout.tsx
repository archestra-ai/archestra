"use client";

import { Info } from "lucide-react";
import { PageLayout } from "@/components/page-layout";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";

/** The tuners page exists only where the deployment has tuners on. */
export default function TunersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const appName = useAppName();
  const enabled = useFeature("tunersEnabled");
  if (enabled === undefined) return null;
  if (enabled) return children;
  return (
    <PageLayout minWidth="phone" title="Tuners">
      <InlineNotice variant="neutral">
        <Info />
        <span className="font-medium">Tuners are off</span>
        <InlineNoticeText>
          This {appName} deployment does not have tuners enabled.
        </InlineNoticeText>
      </InlineNotice>
    </PageLayout>
  );
}
