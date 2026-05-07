"use client";

import Handlebars from "handlebars";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { useIdentityProviderLatestIdTokenClaims } from "@/lib/auth/identity-provider.query.ee";

type TemplateTestMode = "role" | "team-sync";

interface SsoTemplateTesterProps {
  identityProviderId?: string;
  template: string | undefined;
  templateLabel: string;
  mode: TemplateTestMode;
}

let helpersRegistered = false;

registerSsoTemplateHelpers();

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
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Live Template Test</div>
          <p className="text-xs text-muted-foreground">
            Runs {templateLabel} against your latest decoded ID token claims.
          </p>
        </div>

        {result && (
          <div className="flex items-center gap-2 sm:ml-auto sm:justify-end sm:text-right">
            <Badge variant={result.ok ? "default" : "destructive"}>
              {result.label}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {result.description}
            </span>
          </div>
        )}
      </div>

      {disabledReason && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}

      {result && (
        <div>
          {result.output && (
            <pre className="max-h-32 overflow-auto rounded-md bg-background p-2 text-xs font-mono whitespace-pre-wrap break-words">
              {result.output}
            </pre>
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

function registerSsoTemplateHelpers() {
  if (helpersRegistered) return;
  helpersRegistered = true;

  Handlebars.registerHelper("json", (context) => {
    if (typeof context === "string") {
      try {
        return JSON.parse(context);
      } catch {
        return context;
      }
    }
    return JSON.stringify(context);
  });

  Handlebars.registerHelper(
    "includes",
    function (
      this: unknown,
      array: unknown,
      value: unknown,
      options: Handlebars.HelperOptions,
    ) {
      if (!Array.isArray(array)) return options.inverse(this);
      const found = array.some((item) => {
        if (typeof item === "string" && typeof value === "string") {
          return item.toLowerCase() === value.toLowerCase();
        }
        return item === value;
      });
      return found ? options.fn(this) : options.inverse(this);
    },
  );

  Handlebars.registerHelper(
    "contains",
    function (
      this: unknown,
      str: unknown,
      substring: unknown,
      options: Handlebars.HelperOptions,
    ) {
      if (typeof str !== "string" || typeof substring !== "string") {
        return options.inverse(this);
      }
      return str.toLowerCase().includes(substring.toLowerCase())
        ? options.fn(this)
        : options.inverse(this);
    },
  );

  Handlebars.registerHelper(
    "equals",
    function (
      this: unknown,
      a: unknown,
      b: unknown,
      options: Handlebars.HelperOptions,
    ) {
      if (typeof a === "string" && typeof b === "string") {
        return a.toLowerCase() === b.toLowerCase()
          ? options.fn(this)
          : options.inverse(this);
      }
      return a === b ? options.fn(this) : options.inverse(this);
    },
  );

  Handlebars.registerHelper(
    "and",
    function (this: unknown, ...args: unknown[]) {
      const options = args.pop() as Handlebars.HelperOptions;
      return args.every(Boolean) ? options.fn(this) : options.inverse(this);
    },
  );

  Handlebars.registerHelper("or", function (this: unknown, ...args: unknown[]) {
    const options = args.pop() as Handlebars.HelperOptions;
    return args.some(Boolean) ? options.fn(this) : options.inverse(this);
  });

  Handlebars.registerHelper(
    "exists",
    function (
      this: unknown,
      value: unknown,
      options: Handlebars.HelperOptions,
    ) {
      return value !== null && value !== undefined
        ? options.fn(this)
        : options.inverse(this);
    },
  );

  Handlebars.registerHelper("pluck", (array, property) => {
    if (!Array.isArray(array)) return [];
    return array
      .map((item) =>
        typeof item === "object" && item
          ? (item as Record<string, unknown>)[property]
          : null,
      )
      .filter((value) => value !== null && value !== undefined);
  });
}
