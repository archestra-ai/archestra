"use client";

import { DocsPage } from "@archestra/shared";
import { Info } from "lucide-react";
import Link from "next/link";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";

const TABS = [
  { label: "Overview", href: "/llm/auto-routing" },
  { label: "Plans", href: "/llm/auto-routing/plans" },
  { label: "Diagnostics", href: "/llm/auto-routing/diagnostics" },
];

export default function AutoRoutingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const appName = useAppName();
  const enabled = useFeature("autoRoutingEnabled");
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformLlmProxyAutoRouting);

  return (
    <PageLayout
      minWidth="phone"
      title="Auto Routing"
      description={
        <>
          The <code>auto</code> model on the Model Router picks a fast, normal
          or smart model per session within a daily budget.
          {docsUrl && (
            <span>
              {" "}
              <ExternalDocsLink href={docsUrl} className="hover:underline">
                Learn more
              </ExternalDocsLink>
            </span>
          )}
          <span className="block">
            Clients use it by requesting model <code>auto</code> through the{" "}
            <Link href="/llm/proxy" className="underline">
              Model Router
            </Link>
            .
          </span>
        </>
      }
      tabs={enabled ? TABS : []}
    >
      {enabled === undefined ? null : enabled === false ? (
        <InlineNotice variant="neutral">
          <Info />
          <span className="font-medium">Auto routing is off</span>
          <InlineNoticeText>
            This {appName} deployment does not have the auto routing alpha
            enabled.
          </InlineNoticeText>
        </InlineNotice>
      ) : (
        children
      )}
    </PageLayout>
  );
}
