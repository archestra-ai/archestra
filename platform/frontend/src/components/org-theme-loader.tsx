"use client";

import { useOrgTheme } from "@/lib/theme.hook";

export function OrgThemeLoader() {
  useOrgTheme();
  return null;
}
