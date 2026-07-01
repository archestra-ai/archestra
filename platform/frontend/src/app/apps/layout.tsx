"use client";

import { notFound } from "next/navigation";
import type React from "react";
import { useFeature } from "@/lib/config/config.query";

// Apps ship dark behind ARCHESTRA_APPS_ENABLED. When off, the backend 404s every
// /api/apps route and the nav hides — gate the pages too so a direct visit 404s
// rather than rendering a shell over failing queries. `undefined` (still loading)
// renders children to avoid flashing not-found.
export default function AppsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const appsEnabled = useFeature("appsEnabled");
  if (appsEnabled === false) notFound();
  return <>{children}</>;
}
