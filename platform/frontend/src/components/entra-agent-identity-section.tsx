// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { DocsPage } from "@archestra/shared";
import { useId } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SettingsSection } from "@/components/settings-section";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";

/**
 * Binds an agent to its own Microsoft Entra agent identity. Changing it is an
 * identity decision, so it takes `identityProvider:update`, the same as the
 * backend's check.
 */
export function EntraAgentIdentitySection({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const docsUrl = getFrontendDocsUrl(DocsPage.PlatformEntraAgentId);
  const { data: canUpdateIdentityProviders } = useHasPermissions({
    identityProvider: ["update"],
  });

  return (
    <SettingsSection
      title="Entra agent identity"
      description="The Microsoft Entra identity this agent's tools act through."
    >
      <div className="space-y-2">
        <Label htmlFor={inputId}>Agent identity app ID</Label>
        <FieldDescription>
          Tools that exchange the user&apos;s Entra token then run as the user,
          through this agent. Downstream tokens name the agent identity as the
          client, so Entra consent and sign-in logs apply to this agent alone.
          Leave empty to use the shared client.
          {docsUrl && (
            <ExternalDocsLink
              href={docsUrl}
              className="ml-1 underline"
              showIcon={false}
            >
              Learn more
            </ExternalDocsLink>
          )}
        </FieldDescription>
        <Input
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          className="font-mono"
          disabled={!canUpdateIdentityProviders}
        />
        {!canUpdateIdentityProviders && (
          <FieldDescription>
            Changing it requires permission to update identity providers.
          </FieldDescription>
        )}
      </div>
    </SettingsSection>
  );
}
