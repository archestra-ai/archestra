"use client";

import {
  extractSsoGroupsFromClaims,
  extractSsoGroupsFromRenderedTemplate,
  isTruthyTemplateOutput,
  registerSsoTemplateHelpers,
} from "@shared";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIdentityProviderLatestIdTokenClaims } from "@/lib/auth/identity-provider.query.ee";
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
}

let helpersRegistered = false;

export function SsoTemplateTester({
  identityProviderId,
  template,
  templateLabel,
  mode,
  roleRules,
  defaultRole,
  strictMode = false,
}: SsoTemplateTesterProps) {
  const { data, isLoading } =
    useIdentityProviderLatestIdTokenClaims(identityProviderId);
  const claims = data?.claims;
  const [result, setResult] = useState<TemplateTestResult | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const disabledReason = useMemo(() => {
    if (!identityProviderId) {
      return "Save this provider and sign in with it before testing templates.";
    }
    if (isLoading) return "Loading latest ID token claims.";
    if (!claims) return "No latest ID token claims are available to test.";
    if (mode === "role" && !template?.trim())
      return "Enter a template to test.";
    return null;
  }, [claims, identityProviderId, isLoading, mode, template]);

  useEffect(() => {
    let cancelled = false;
    if (disabledReason || !claims) {
      setResult(null);
      setIsEvaluating(false);
      return;
    }

    setIsEvaluating(true);
    evaluateTemplate({
      claims,
      defaultRole,
      mode,
      roleRules,
      strictMode,
      template,
    }).then((nextResult) => {
      if (cancelled) return;
      setResult(nextResult);
      setIsEvaluating(false);
    });

    return () => {
      cancelled = true;
    };
  }, [
    claims,
    defaultRole,
    disabledReason,
    mode,
    roleRules,
    strictMode,
    template,
  ]);

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Live Template Test</div>
        <p className="text-xs text-muted-foreground">
          Runs {templateLabel} against your latest decoded ID token claims.
        </p>
      </div>

      {result && (
        <div className="flex flex-col gap-2 rounded-md border bg-background/50 px-3 py-2 sm:flex-row sm:items-center">
          <Badge
            variant={result.ok ? "secondary" : "destructive"}
            className="w-fit"
          >
            {result.label}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {result.description}
          </span>
        </div>
      )}

      {disabledReason && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}
      {isEvaluating && !result && (
        <p className="text-xs text-muted-foreground">
          Loading template tester.
        </p>
      )}

      {result && (
        <div>
          {result.output && (
            <ScrollArea className="max-h-40 overflow-auto rounded-md border bg-muted/40">
              <pre className="p-3 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
                {result.output}
              </pre>
            </ScrollArea>
          )}
        </div>
      )}
    </div>
  );
}

interface TemplateTestResult {
  ok: boolean;
  label: string;
  description: string;
  output?: string;
}

async function evaluateTemplate(params: {
  claims: Record<string, unknown>;
  defaultRole: string | undefined;
  mode: SsoTemplateTestMode;
  roleRules: SsoRoleMappingRule[] | undefined;
  strictMode: boolean;
  template: string | undefined;
}): Promise<TemplateTestResult> {
  try {
    if (params.mode === "role") {
      const handlebars = await loadHandlebars();
      const compiled = handlebars.compile(params.template ?? "", {
        noEscape: true,
      });
      const output = compiled(params.claims).trim();
      const matched = isTruthyTemplateOutput(output);
      return {
        ok: matched,
        label: matched ? "Match" : "No match",
        description: getRoleMappingDescription({
          outcome: evaluateRoleMappingOutcome({
            claims: params.claims,
            defaultRole: params.defaultRole,
            handlebars,
            roleRules: params.roleRules,
            strictMode: params.strictMode,
          }),
          selectedRuleMatched: matched,
        }),
      };
    }

    const hasTemplate = Boolean(params.template?.trim());
    if (!hasTemplate) {
      const groups = extractSsoGroupsFromClaims(params.claims);
      return {
        ok: groups.length > 0,
        label: groups.length > 0 ? "Groups extracted" : "No groups",
        description:
          groups.length > 0
            ? `${groups.length} group identifier${groups.length === 1 ? "" : "s"} extracted using default extraction.`
            : "Default extraction did not find any group identifiers.",
        output: JSON.stringify(groups, null, 2),
      };
    }

    const handlebars = await loadHandlebars();
    const output = handlebars
      .compile(params.template ?? "", { noEscape: true })(params.claims)
      .trim();
    const groups = extractSsoGroupsFromRenderedTemplate(output);
    return {
      ok: groups.length > 0,
      label: groups.length > 0 ? "Groups extracted" : "No groups",
      description:
        groups.length > 0
          ? `${groups.length} group identifier${groups.length === 1 ? "" : "s"} extracted.`
          : "This template did not extract any group identifiers.",
      output: JSON.stringify(groups, null, 2),
    };
  } catch (error) {
    return {
      ok: false,
      label: "Error",
      description:
        error instanceof Error
          ? error.message
          : "The template could not be evaluated.",
    };
  }
}

type RoleMappingOutcome =
  | {
      kind: "assigned";
      role: string;
    }
  | {
      kind: "denied";
    };

function evaluateRoleMappingOutcome(params: {
  claims: Record<string, unknown>;
  defaultRole: string | undefined;
  handlebars: HandlebarsRuntime;
  roleRules: SsoRoleMappingRule[] | undefined;
  strictMode: boolean;
}): RoleMappingOutcome {
  for (const rule of params.roleRules ?? []) {
    if (!rule.expression.trim()) continue;
    const compiled = params.handlebars.compile(rule.expression, {
      noEscape: true,
    });
    const output = compiled(params.claims).trim();
    if (isTruthyTemplateOutput(output)) {
      return {
        kind: "assigned",
        role: rule.role,
      };
    }
  }

  if (params.strictMode) {
    return { kind: "denied" };
  }

  return {
    kind: "assigned",
    role: params.defaultRole ?? "member",
  };
}

function getRoleMappingDescription(params: {
  outcome: RoleMappingOutcome;
  selectedRuleMatched: boolean;
}) {
  const selectedRuleText = params.selectedRuleMatched
    ? "The selected rule matches."
    : "The selected rule does not match.";
  if (params.outcome.kind === "denied") {
    return `${selectedRuleText} Based on current rules and your latest token, sign-in would be denied by strict mode.`;
  }

  return `${selectedRuleText} Based on current rules and your latest token, you would be assigned ${formatRoleName(params.outcome.role)}.`;
}

function formatRoleName(role: string) {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

async function loadHandlebars(): Promise<HandlebarsRuntime> {
  const module = await import("handlebars");
  const handlebars = module.default ?? module;
  if (helpersRegistered) return handlebars;
  helpersRegistered = true;

  registerSsoTemplateHelpers({
    registerHelper: (name, helper) => {
      handlebars.registerHelper(name, helper);
    },
  });

  return handlebars;
}
