// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  extractSsoGroupsFromClaims,
  extractSsoGroupsFromRenderedTemplate,
  isTruthyTemplateOutput,
  registerSsoTemplateHelpers,
} from "@archestra/shared";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { JsonCodeBlock } from "@/components/json-code-block";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useIdentityProviderLatestIdTokenClaims } from "@/lib/auth/identity-provider.query.ee";
import { formatRoleName } from "@/lib/utils/role";
import type {
  SsoRoleMappingRule,
  SsoTemplateTestMode,
} from "./sso-template-debug-types.ee";

type HandlebarsRuntime = typeof import("handlebars");
interface SsoTemplateTesterProps {
  identityProviderId?: string;
  template: string | undefined;
  templateLabel: string;
  mode: SsoTemplateTestMode;
  roleRules?: SsoRoleMappingRule[];
  defaultRole?: string;
  strictMode?: boolean;
  teamSyncEnabled?: boolean;
}

const SAMPLE_CLAIMS = {
  sub: "sample-user",
  email: "user@example.com",
  name: "Sample User",
  email_verified: true,
  groups: ["platform-admins", "engineering"],
};
let runtime: Promise<HandlebarsRuntime> | undefined;
type PreviewResult = {
  error?: string;
  roles?: string;
  matchedRuleIndex?: number;
  groups?: string[];
};

export function SsoTemplateTester({
  identityProviderId,
  template,
  mode,
  roleRules,
  defaultRole,
  strictMode = false,
  teamSyncEnabled = true,
}: SsoTemplateTesterProps) {
  const query = useIdentityProviderLatestIdTokenClaims(identityProviderId);
  const claims = query.data?.claims ?? SAMPLE_CLAIMS;
  const [result, setResult] = useState<PreviewResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: PreviewResult;
      try {
        const engine = await loadHandlebars();
        if (mode === "role") {
          next = { roles: strictMode ? undefined : defaultRole || "member" };
          for (const [index, rule] of (roleRules ?? []).entries()) {
            if (!rule.expression.trim()) continue;
            const output = engine
              .compile(rule.expression, { noEscape: true })(claims)
              .trim();
            if (isTruthyTemplateOutput(output)) {
              next = { roles: rule.role, matchedRuleIndex: index };
              break;
            }
          }
        } else {
          next = {
            groups: teamSyncEnabled
              ? template?.trim()
                ? extractSsoGroupsFromRenderedTemplate(
                    engine.compile(template, { noEscape: true })(claims).trim(),
                  )
                : extractSsoGroupsFromClaims(claims)
              : [],
          };
        }
      } catch (error) {
        next = {
          error:
            error instanceof Error
              ? error.message
              : "Could not evaluate this mapping.",
        };
      }
      if (!cancelled) setResult(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    claims,
    defaultRole,
    mode,
    roleRules,
    strictMode,
    teamSyncEnabled,
    template,
  ]);

  const matchingTemplate =
    result?.matchedRuleIndex !== undefined
      ? roleRules?.[result.matchedRuleIndex]?.expression
      : undefined;
  const roleNames = result?.roles?.split(",").map(formatRoleName).join(", ");
  return (
    <section
      className="@container min-w-0 rounded-md border"
      aria-label="Sign-in preview"
    >
      <div className="space-y-1 px-3 py-2.5">
        <h4 className="text-sm font-medium">
          {query.isLoading
            ? "Loading your sign-in data…"
            : query.data?.claims
              ? "Preview using your sign-in data"
              : "Preview using sample data"}
        </h4>
        <p className="text-xs text-muted-foreground">
          {query.data?.claims
            ? "From your latest sign-in with this provider. Updates as you edit."
            : "No saved sign-in data for your account yet. This sample lets you try your mappings."}
        </p>
      </div>
      {query.isError ? (
        <div className="border-t p-3">
          <InlineNotice variant="error">
            <span className="font-medium">Could not load sign-in data.</span>
            <InlineNoticeText>Try loading it again.</InlineNoticeText>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => query.refetch()}
            >
              <span>Try again</span>
            </Button>
          </InlineNotice>
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 border-t @[700px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="min-w-0 p-3">
            <span className="text-xs font-medium">Sign-in data</span>
            <JsonCodeBlock
              value={claims}
              maxHeightClassName="max-h-72 overflow-auto"
            />
          </div>
          <div className="min-w-0 space-y-3 border-t p-3 @[700px]:border-l @[700px]:border-t-0">
            {result?.error ? (
              <InlineNotice variant="error">
                <span className="font-medium">Could not preview mapping.</span>
                <InlineNoticeText>{result.error}</InlineNoticeText>
              </InlineNotice>
            ) : mode === "role" ? (
              <>
                <p
                  className="flex items-start gap-2 text-sm font-medium"
                  aria-live="polite"
                >
                  <Check className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {result?.matchedRuleIndex !== undefined
                      ? `Rule ${result.matchedRuleIndex + 1} → ${roleNames}`
                      : roleNames
                        ? `Default roles → ${roleNames}`
                        : result
                          ? "No matching rule · Sign-in denied"
                          : "Updating preview…"}
                  </span>
                </p>
                {matchingTemplate ? (
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">
                      Matching template
                    </span>
                    <TemplateCode value={matchingTemplate} />
                  </div>
                ) : (
                  result && (
                    <p className="text-xs text-muted-foreground">
                      {roleNames
                        ? "No rule matches this sign-in data, so the default roles apply."
                        : "No rule matches this sign-in data. Strict Mode would prevent sign-in."}
                    </p>
                  )
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-medium" aria-live="polite">
                  {teamSyncEnabled
                    ? `${result?.groups?.length ?? 0} groups extracted`
                    : "Team Sync is off"}
                </p>
                {teamSyncEnabled && (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {result?.groups?.map((group) => (
                        <span
                          key={group}
                          className="rounded-md bg-muted px-2 py-1 text-xs break-all"
                        >
                          {group}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {result?.groups?.length
                        ? "Use these identifiers in each team’s External Group Sync settings."
                        : "This sign-in data does not produce any group identifiers."}
                    </p>
                    <div className="space-y-1.5">
                      <span className="text-xs text-muted-foreground">
                        Groups Handlebars template
                      </span>
                      {template?.trim() ? (
                        <TemplateCode value={template} />
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Default extraction from the sign-in data.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
function TemplateCode({ value }: { value: string }) {
  return (
    <CodeBlock
      code={value}
      language="handlebars"
      wrapLongLines
      contentClassName="overflow-auto [&_code]:text-xs"
      contentStyle={{
        fontSize: "0.75rem",
        padding: "0.75rem",
        paddingTop: "0.75rem",
      }}
    />
  );
}
function loadHandlebars() {
  runtime ??= import("handlebars/dist/handlebars").then((module) => {
    const engine = (module.default ?? module) as HandlebarsRuntime;
    registerSsoTemplateHelpers({
      registerHelper: (name, helper) => engine.registerHelper(name, helper),
    });
    return engine;
  });
  return runtime;
}
