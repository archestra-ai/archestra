"use client";

import { notFound } from "next/navigation";
import type React from "react";
import { useFeature } from "@/lib/config/config.query";

// Standalone app runtime (/a/[id]) lives outside /apps but is the same feature,
// so gate it on ARCHESTRA_APPS_ENABLED the same way (see apps/layout.tsx).
export default function StandaloneAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const appsEnabled = useFeature("appsEnabled");
  if (appsEnabled === false) notFound();
  return <>{children}</>;
}
