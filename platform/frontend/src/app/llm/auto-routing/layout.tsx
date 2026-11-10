"use client";

import { DocsPage } from "@archestra/shared";
import { Info } from "lucide-react";
import Link from "next/link";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useAutoRoutingSettings } from "@/lib/auto-routing.query";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { ConfigureAutoRoutingButton } from "./_parts/configure-button";
import { isAutoRoutingSetUp } from "./_parts/setup-cards";

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
      status={enabled ? <AutoRoutingStatus /> : undefined}
      actionButton={enabled ? <ConfigureAutoRoutingButton /> : undefined}
      description={
        <>
          The <code>auto</code> model picks a fast, normal or smart model for
          each session within a daily budget. Pick it for any agent or chat, as
          the organization default, or request it on the{" "}
          <Link href="/llm/proxy" className="underline">
            Unified Model API
          </Link>
          .
          {docsUrl && (
            <span>
              {" "}
              <ExternalDocsLink href={docsUrl} className="hover:underline">
                Learn more
              </ExternalDocsLink>
            </span>
          )}
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

/** On, off, or still being set up. */
function AutoRoutingStatus() {
  const { data: settings } = useAutoRoutingSettings();
  if (!settings) return null;
  const label = isAutoRoutingSetUp(settings)
    ? "On"
    : settings.enabled
      ? "Needs setup"
      : "Off";
  return (
    <Badge variant="outline" data-testid="auto-routing-header-status">
      <span
        aria-hidden
        className={
          label === "On"
            ? "size-2 rounded-full bg-emerald-500"
            : label === "Off"
              ? "size-2 rounded-full border border-muted-foreground"
              : "size-2 rounded-full bg-amber-500"
        }
      />
      <span>{label}</span>
    </Badge>
  );
}
