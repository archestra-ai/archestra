"use client";

import { DefaultUserLimitsSection } from "@/app/settings/llm/_parts/default-user-limits-section";
import { ModelProvidersSection } from "@/app/settings/llm/_parts/model-providers-section";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsSectionStack } from "@/components/settings/settings-block";

export default function LlmSettingsPage() {
  return (
    <SettingsSectionStack>
      <WithPermissions
        permissions={{ llmLimit: ["read"] }}
        noPermissionHandle="hide"
      >
        <DefaultUserLimitsSection />
      </WithPermissions>
      <ModelProvidersSection />
    </SettingsSectionStack>
  );
}
