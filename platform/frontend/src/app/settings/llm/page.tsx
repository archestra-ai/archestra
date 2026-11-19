"use client";

import { AutoRoutingSection } from "@/app/settings/llm/_parts/auto-routing-section";
import { MediaInLogsSection } from "@/app/settings/llm/_parts/media-in-logs-section";
import { ModelProvidersSection } from "@/app/settings/llm/_parts/model-providers-section";
import { UnauthenticatedLlmProxySection } from "@/app/settings/llm/_parts/unauthenticated-llm-proxy-section";
import { SettingsSectionStack } from "@/components/settings/settings-block";

export default function LlmSettingsPage() {
  return (
    <SettingsSectionStack>
      <UnauthenticatedLlmProxySection />
      <MediaInLogsSection />
      <AutoRoutingSection />
      <ModelProvidersSection />
    </SettingsSectionStack>
  );
}
