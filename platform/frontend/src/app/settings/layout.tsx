"use client";

import { PageLayout } from "@/components/page-layout";
import { useSettingsTabs } from "./settings-tabs";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tabs = useSettingsTabs();

  return (
    <PageLayout
      title="Settings"
      description="Configure your platform, teams, and integrations"
      tabs={tabs}
    >
      {children}
    </PageLayout>
  );
}
