"use client";

import Link from "next/link";
import { Fragment } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AudienceLevel,
  useTrustAudience,
} from "@/lib/openappa-trust-audience.query";
import { policyLineHref, policyLineLabel } from "./policy-line-href";

/** The Overview's trust chain and audiences, with who belongs to each audience. */
export function TrustAudienceCard() {
  const view = useTrustAudience();

  return (
    <Card className="gap-5 py-5">
      <CardHeader className="px-5">
        <CardTitle>Trust & audience</CardTitle>
        <CardDescription>
          Trust is how much the agent can believe what it has read. Audience is
          who is allowed to see it: reading something private limits where the
          agent can send it.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5">
        {view.isLoadingError ? (
          <QueryLoadError
            title="Could not load trust and audience"
            onRetry={() => view.refetch()}
          />
        ) : !view.data ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-4 text-sm">
            <dt className="text-muted-foreground">Trust</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              {view.data.trust.map((name, index) => (
                <Fragment key={name}>
                  {index > 0 && (
                    <span
                      aria-hidden="true"
                      className="text-xs text-muted-foreground"
                    >
                      →
                    </span>
                  )}
                  <Badge variant="outline" className="font-mono">
                    {name}
                  </Badge>
                </Fragment>
              ))}
            </dd>
            <dt className="text-muted-foreground">Audience</dt>
            <dd>
              <dl className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-4 gap-y-2">
                {view.data.audiences.map((level) => (
                  <Fragment key={level.name}>
                    <dt>
                      <Badge variant="outline" className="font-mono">
                        {level.name}
                      </Badge>
                    </dt>
                    <dd className="self-center">
                      <Members level={level} />
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Internal components
// =============================================================================

/**
 * Who the runtime counts in a level. A user's session carries its user as the
 * principal, which is `self` whenever a session has one; `internal` adds its
 * mapped sources to it.
 */
function Members({ level }: { level: AudienceLevel }) {
  if (level.kind === "mapped")
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {level.from.map((ref, index) => (
          <Fragment key={`${ref.source}:${ref.selector}`}>
            {index > 0 && <span className="text-muted-foreground">or</span>}
            <span className="font-mono">
              {ref.source}:{ref.selector}
            </span>
          </Fragment>
        ))}
        {level.within && (
          <span className="text-muted-foreground">within {level.within}</span>
        )}
        <Link
          href={policyLineHref({ entry: null, line: level.mappingLine })}
          className="font-mono text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          {policyLineLabel({ entry: null, line: level.mappingLine })}
        </Link>
      </span>
    );
  return (
    <span className="text-muted-foreground">
      {UNMAPPED_MEMBERS[level.name]}
    </span>
  );
}

const UNMAPPED_MEMBERS: Record<string, string> = {
  public: "Anyone",
  internal: "Only the session's user",
  self: "The session's user",
};
