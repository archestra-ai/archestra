"use client";

import { Mail } from "lucide-react";
import { useMemo } from "react";
import { PageLayout } from "@/components/page-layout";
import { useHasPermissions } from "@/lib/auth.query";
import { cn } from "@/lib/utils";
import { useTriggerStatuses } from "./_components/use-trigger-statuses";

function TabLabel({
  iconSrc,
  icon: Icon,
  label,
  active,
}: {
  iconSrc?: string;
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      {iconSrc ? (
        <img src={iconSrc} alt="" className="h-4 w-4" />
      ) : Icon ? (
        <Icon className="h-4 w-4" />
      ) : null}
      {label}
      <span
        className={cn(
          "text-[11px] px-1.5 py-0.5 rounded-full font-normal",
          active
            ? "bg-green-500/10 text-green-600 dark:text-green-400"
            : "bg-muted text-muted-foreground",
        )}
      >
        {active ? "Active" : "Configure"}
      </span>
    </span>
  );
}

export default function AgentTriggersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: canUpdate } = useHasPermissions({
    organization: ["update"],
  });
  const {
    msTeams: msTeamsActive,
    slack: slackActive,
    email: emailActive,
  } = useTriggerStatuses();

  const tabs = useMemo(() => {
    const allTabs = [
      {
        label: (
          <TabLabel
            iconSrc="/icons/ms-teams.png"
            label="MS Teams"
            active={msTeamsActive}
          />
        ),
        href: "/agent-triggers/ms-teams",
        active: msTeamsActive,
      },
      {
        label: (
          <TabLabel
            iconSrc="/icons/slack.png"
            label="Slack"
            active={slackActive}
          />
        ),
        href: "/agent-triggers/slack",
        active: slackActive,
      },
      {
        label: <TabLabel icon={Mail} label="Email" active={emailActive} />,
        href: "/agent-triggers/email",
        active: emailActive,
      },
    ];

    // Sort: active tabs first
    return allTabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  }, [msTeamsActive, slackActive, emailActive]);

  if (canUpdate === false) {
    return null;
  }

  return (
    <PageLayout
      title="Triggers"
      description="Manage how your agents connect to messaging channels"
      tabs={tabs}
    >
      {children}
    </PageLayout>
  );
}
