"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useFeature } from "@/lib/config/config.query";

export default function SkillsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Skills are gated behind the ARCHESTRA_AGENTS_SKILLS_ENABLED env var; when
  // off, the page is unreachable so an org cannot opt in to the feature.
  const skillsEnabled = useFeature("agentSkillsEnabled");
  const router = useRouter();

  useEffect(() => {
    if (skillsEnabled === false) {
      router.replace("/agents");
    }
  }, [skillsEnabled, router]);

  if (skillsEnabled !== true) {
    return null;
  }

  return <ErrorBoundary>{children}</ErrorBoundary>;
}
