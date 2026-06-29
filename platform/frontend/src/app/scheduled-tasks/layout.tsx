"use client";

import { PageLayout } from "@/components/page-layout";

export default function ScheduledTasksLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageLayout
      title="Scheduled Tasks"
      description="Run agent tasks on a schedule or trigger them anytime. Follow up on results in chat."
    >
      {children}
    </PageLayout>
  );
}
