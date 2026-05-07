"use client";

import { Separator } from "@/components/ui/separator";
import { IdTokenClaimsDebugger } from "./id-token-claims-debugger.ee";
import { SsoTemplateTester } from "./sso-template-tester.ee";

interface SsoTemplateDebugSectionProps {
  identityProviderId?: string;
  template: string | undefined;
  templateLabel: string;
  mode: "role" | "team-sync";
  examples: Array<{
    expression: string;
    description: string;
  }>;
}

export function SsoTemplateDebugSection({
  identityProviderId,
  template,
  templateLabel,
  mode,
  examples,
}: SsoTemplateDebugSectionProps) {
  return (
    <div className="space-y-4">
      <Separator />
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Template Debugger</h3>
        <p className="text-xs text-muted-foreground">
          Inspect available claims, test the current template, and compare it
          with common examples.
        </p>
      </div>

      <SsoTemplateTester
        identityProviderId={identityProviderId}
        mode={mode}
        template={template}
        templateLabel={templateLabel}
      />

      <IdTokenClaimsDebugger identityProviderId={identityProviderId} />

      <div className="rounded-md border bg-muted/30 p-4">
        <h4 className="mb-3 text-sm font-medium">Example Templates</h4>
        <ul className="space-y-2 text-sm text-muted-foreground">
          {examples.map(({ expression, description }) => (
            <li key={`${expression}-${description}`}>
              <code className="text-xs bg-muted px-1 py-0.5 rounded break-all">
                {expression}
              </code>
              <span className="ml-2">- {description}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground mt-3">
          Templates can use helpers such as includes, equals, contains, and, or,
          exists, json, and pluck.
        </p>
      </div>
    </div>
  );
}
