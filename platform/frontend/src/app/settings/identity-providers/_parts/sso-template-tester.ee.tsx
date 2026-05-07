"use client";

import { registerSsoTemplateHelpers } from "@shared";
import Handlebars from "handlebars";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIdentityProviderLatestIdTokenClaims } from "@/lib/auth/identity-provider.query.ee";

type TemplateTestMode = "role" | "team-sync";

interface SsoTemplateTesterProps {
  identityProviderId?: string;
  template: string | undefined;
  templateLabel: string;
  mode: TemplateTestMode;
}

let helpersRegistered = false;

registerTemplateHelpers();

export function SsoTemplateTester({
  identityProviderId,
  template,
  templateLabel,
  mode,
}: SsoTemplateTesterProps) {
  const { data, isLoading } =
    useIdentityProviderLatestIdTokenClaims(identityProviderId);
  const claims = data?.claims;
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
  const result = useMemo(() => {
    if (disabledReason || !claims) return null;
    return evaluateTemplate({ claims, mode, template });
  }, [claims, disabledReason, mode, template]);

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

function evaluateTemplate(params: {
  claims: Record<string, unknown>;
  mode: TemplateTestMode;
  template: string | undefined;
}): TemplateTestResult {
  try {
    if (params.mode === "role") {
      const compiled = Handlebars.compile(params.template ?? "", {
        noEscape: true,
      });
      const output = compiled(params.claims).trim();
      const matched = output.length > 0 && output !== "false" && output !== "0";
      return {
        ok: matched,
        label: matched ? "Match" : "No match",
        description: matched
          ? "This role mapping rule would match these claims."
          : "This role mapping rule would not match these claims.",
        output,
      };
    }

    const hasTemplate = Boolean(params.template?.trim());
    const output = hasTemplate
      ? Handlebars.compile(params.template ?? "", { noEscape: true })(
          params.claims,
        ).trim()
      : "";
    const groups = hasTemplate
      ? extractGroupsFromRenderedTemplate(output)
      : extractGroupsFromClaims(params.claims);
    return {
      ok: groups.length > 0,
      label: groups.length > 0 ? "Groups extracted" : "No groups",
      description:
        groups.length > 0
          ? `${groups.length} group identifier${groups.length === 1 ? "" : "s"} extracted${hasTemplate ? "" : " using default extraction"}.`
          : hasTemplate
            ? "This template did not extract any group identifiers."
            : "Default extraction did not find any group identifiers.",
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

function extractGroupsFromClaims(claims: Record<string, unknown>): string[] {
  const groupClaimNames = [
    "groups",
    "group",
    "memberOf",
    "member_of",
    "roles",
    "role",
    "teams",
    "team",
  ];

  for (const claimName of groupClaimNames) {
    const groups = normalizeGroups(claims[claimName]);
    if (groups.length > 0) return groups;
  }

  return [];
}

function extractGroupsFromRenderedTemplate(output: string): string[] {
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim());
    }
  } catch {
    // Not JSON; fall through to comma-separated parsing.
  }
  return output
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeGroups(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => normalizeGroups(item))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    if (!value.trim()) return [];
    if (value.includes(",")) {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [value.trim()];
  }

  return [];
}

function registerTemplateHelpers() {
  if (helpersRegistered) return;
  helpersRegistered = true;

  registerSsoTemplateHelpers({
    registerHelper: (name, helper) => {
      Handlebars.registerHelper(name, helper);
    },
  });
}
