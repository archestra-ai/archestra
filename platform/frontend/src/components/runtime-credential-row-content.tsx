import type { ReactNode } from "react";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { Badge } from "@/components/ui/badge";
import type { RuntimeCredentialDefinition } from "@/lib/runtime-credentials.query";

export function RuntimeCredentialRowContent({
  definition,
  configured = false,
  meta,
}: {
  definition: RuntimeCredentialDefinition;
  configured?: boolean;
  meta?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
        <RuntimeCredentialIcon icon={definition.icon} />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-medium">{definition.name}</h3>
          {configured && (
            <Badge variant="secondary" className="font-normal">
              Connected
            </Badge>
          )}
          {definition.builtIn && (
            <Badge variant="outline" className="font-normal">
              Built-in
            </Badge>
          )}
        </div>
        <RuntimeCredentialDescription definition={definition} />
        {meta && <p className="mt-1 text-xs text-muted-foreground">{meta}</p>}
      </div>
    </div>
  );
}

export function RuntimeCredentialDescription({
  definition,
  className = "mt-1",
}: {
  definition: RuntimeCredentialDefinition;
  className?: string;
}) {
  if (definition.key === "claude-code") {
    return (
      <p className={`${className} text-xs text-muted-foreground`}>
        Use a personal subscription token created with{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground">
          claude setup-token
        </code>
        .
      </p>
    );
  }

  if (definition.key === "github") {
    return (
      <p className={`${className} text-xs text-muted-foreground`}>
        Use a GitHub personal access token with access to the repositories this
        Agent needs. Create one in{" "}
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          GitHub Developer settings
        </a>
        .
      </p>
    );
  }

  if (!definition.description.trim()) return null;
  return (
    <p className={`${className} text-xs text-muted-foreground`}>
      {definition.description}
    </p>
  );
}
