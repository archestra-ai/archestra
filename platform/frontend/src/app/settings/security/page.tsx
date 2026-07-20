"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CallPolicyToggle } from "@/components/call-policy-toggle";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { ResultPolicyToggle } from "@/components/result-policy-toggle";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import {
  useOrganization,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";
import type { CallPolicyAction, ResultPolicyAction } from "@/lib/policy.utils";

const DEFAULT_INVOCATION_POLICY: CallPolicyAction =
  "allow_when_context_is_untrusted";
const DEFAULT_RESULT_POLICY: ResultPolicyAction = "mark_as_untrusted";

export default function SecuritySettingsPage() {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateSecuritySettings(
    "Security settings updated",
    "Failed to update security settings",
  );

  const [invocationPolicy, setInvocationPolicy] = useState<CallPolicyAction>(
    DEFAULT_INVOCATION_POLICY,
  );
  const [resultPolicy, setResultPolicy] = useState<ResultPolicyAction>(
    DEFAULT_RESULT_POLICY,
  );
  const savedRef = useRef({
    invocationPolicy: DEFAULT_INVOCATION_POLICY,
    resultPolicy: DEFAULT_RESULT_POLICY,
  });
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!organization || initializedRef.current) return;
    const saved = {
      invocationPolicy:
        organization.defaultDiscoveredToolInvocationPolicy ??
        DEFAULT_INVOCATION_POLICY,
      resultPolicy:
        organization.defaultDiscoveredToolResultPolicy ?? DEFAULT_RESULT_POLICY,
    };
    setInvocationPolicy(saved.invocationPolicy);
    setResultPolicy(saved.resultPolicy);
    savedRef.current = saved;
    initializedRef.current = true;
  }, [organization]);

  const hasChanges =
    invocationPolicy !== savedRef.current.invocationPolicy ||
    resultPolicy !== savedRef.current.resultPolicy;
  const isSaving = updateMutation.isPending;

  const handleSave = async () => {
    await updateMutation.mutateAsync({
      defaultDiscoveredToolInvocationPolicy: invocationPolicy,
      defaultDiscoveredToolResultPolicy: resultPolicy,
    });
    savedRef.current = { invocationPolicy, resultPolicy };
  };

  const handleCancel = () => {
    setInvocationPolicy(savedRef.current.invocationPolicy);
    setResultPolicy(savedRef.current.resultPolicy);
  };

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Default Guardrails for MCP Tools"
        description={
          <>
            Every new tool your agents use — whether discovered through the LLM
            Proxy or added from an MCP server — starts with these guardrails.{" "}
            <ExternalDocsLink
              href={getDocsUrl(DocsPage.PlatformAiToolGuardrails)}
              className="text-primary hover:underline"
              showIcon={false}
            >
              Learn how guardrails work.
            </ExternalDocsLink>
          </>
        }
        control={null}
        notice={
          <span className="text-muted-foreground">
            Existing tools keep their policies; adjust any tool under{" "}
            <Link
              href="/mcp/tool-guardrails"
              className="text-primary hover:underline"
            >
              Guardrails
            </Link>
            .
          </span>
        }
      >
        <WithPermissions
          permissions={{ agentSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <div className="flex flex-col gap-6">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Call Policy</p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    This policy controls whether a tool may run in the current
                    context.
                  </p>
                </div>
                <div className="flex w-[150px] shrink-0 justify-start">
                  <CallPolicyToggle
                    size="sm"
                    value={invocationPolicy}
                    onChange={setInvocationPolicy}
                    disabled={isSaving || !hasPermission}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Results are</p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    This policy controls how tool output is treated after a tool
                    runs.
                  </p>
                </div>
                <div className="flex w-[150px] shrink-0 justify-start">
                  <ResultPolicyToggle
                    size="sm"
                    value={resultPolicy}
                    onChange={setResultPolicy}
                    disabled={isSaving || !hasPermission}
                  />
                </div>
              </div>
            </div>
          )}
        </WithPermissions>
      </SettingsBlock>
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={isSaving}
        permissions={{ agentSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </SettingsSectionStack>
  );
}
