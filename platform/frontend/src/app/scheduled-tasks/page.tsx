"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useFeature } from "@/lib/config/config.query";
import { ScheduleTriggersIndexPage } from "./schedule-triggers-client";

export default function Page() {
  const router = useRouter();
  // With the projects feature on, schedules are managed per-project on the
  // project detail page; the standalone page is retired.
  const projectsEnabled = useFeature("projectsEnabled") === true;

  useEffect(() => {
    if (projectsEnabled) {
      router.replace("/projects");
    }
  }, [projectsEnabled, router]);

  if (projectsEnabled) {
    return null;
  }

  return <ScheduleTriggersIndexPage />;
}
