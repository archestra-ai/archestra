"use client";

import type {
  SsoRoleMappingRule,
  SsoTemplateTestMode,
} from "./sso-template-debug-types.ee";
import { SsoTemplateTester } from "./sso-template-tester.ee";

interface SsoTemplateDebugSectionProps {
  identityProviderId?: string;
  template: string | undefined;
  templateLabel: string;
  mode: SsoTemplateTestMode;
  roleRules?: SsoRoleMappingRule[];
  defaultRole?: string;
  strictMode?: boolean;
  teamSyncEnabled?: boolean;
  examples?: Array<{
    expression: string;
    description: string;
  }>;
}

export function SsoTemplateDebugSection({
  identityProviderId,
  template,
  templateLabel,
  mode,
  roleRules,
  defaultRole,
  strictMode,
  teamSyncEnabled,
}: SsoTemplateDebugSectionProps) {
  return (
    <SsoTemplateTester
      identityProviderId={identityProviderId}
      mode={mode}
      template={template}
      templateLabel={templateLabel}
      roleRules={roleRules}
      defaultRole={defaultRole}
      strictMode={strictMode}
      teamSyncEnabled={teamSyncEnabled}
    />
  );
}
