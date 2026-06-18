"use client";

import { notFound } from "next/navigation";
import type React from "react";
import { useFeature } from "@/lib/config/config.query";

// My Files ships dark behind ARCHESTRA_PROJECTS_ENABLED. When off, the backend
// 404s the My Files endpoints and the nav hides — gate the page too so a direct
// visit 404s rather than rendering a shell over failing queries. `undefined`
// (still loading) renders children to avoid flashing not-found.
export default function MyFilesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const projectsEnabled = useFeature("projectsEnabled");
  if (projectsEnabled === false) notFound();
  return <>{children}</>;
}
