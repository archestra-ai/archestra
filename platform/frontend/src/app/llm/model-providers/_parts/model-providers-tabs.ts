"use client";

import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import { usePermissionMap } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";

export const MODEL_PROVIDERS_TITLE = "Model Providers";

const TABS = [
  { label: "Subscriptions & API Keys", href: "/llm/model-providers" },
  { label: "Models", href: "/llm/models" },
];

/**
 * The tab bar Model Providers and Models share: one sidebar row, two pages.
 * Each tab keeps its own route and permission, so a reader who may open only
 * one of them gets that page without a tab bar.
 */
export function useModelProvidersTabs() {
  const pageMap = usePermissionMap(requiredPagePermissionsMap);
  const agentRuntimeEnabled = useFeature("agentRuntime") === true;
  const tabs = TABS.filter(
    ({ href }) =>
      pageMap?.[href] === true ||
      (href === "/llm/model-providers" && agentRuntimeEnabled),
  );
  return tabs.length > 1 ? tabs : [];
}
