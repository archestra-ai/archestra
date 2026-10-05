"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useTrustAudience } from "@/lib/openappa-trust-audience.query";
import { LevelChain } from "./trust-audience-view";

/** The Overview's summary of the trust and audience levels, linking to their tab. */
export function TrustAudienceCard() {
  const view = useTrustAudience();
  const unmapped =
    view.data?.audiences.filter((level) => level.kind === "unmapped").length ??
    0;

  return (
    <Card className="max-w-md gap-4 py-5">
      <CardHeader className="px-5">
        <CardTitle>Trust & audience</CardTitle>
      </CardHeader>
      <CardContent className="px-5">
        {view.isLoadingError ? (
          <QueryLoadError
            title="Could not load trust and audience"
            onRetry={() => view.refetch()}
          />
        ) : !view.data ? (
          <Skeleton className="h-14 w-full" />
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-muted-foreground">Trust</dt>
            <dd>
              <LevelChain levels={view.data.trust.map((name) => ({ name }))} />
            </dd>
            <dt className="text-muted-foreground">Audience</dt>
            <dd>
              <LevelChain
                levels={view.data.audiences.map((level) => ({
                  name: level.name,
                  warn: level.kind === "unmapped",
                }))}
              />
            </dd>
          </dl>
        )}
      </CardContent>
      <CardFooter className="flex-wrap gap-3 px-5">
        <Button variant="outline" size="sm" asChild>
          <Link href="/openappa/trust-audience">Details →</Link>
        </Button>
        {unmapped > 0 && (
          <InlineNotice>
            <AlertTriangle className="size-4 shrink-0" />
            <InlineNoticeText>{unmapped} audience not mapped</InlineNoticeText>
          </InlineNotice>
        )}
      </CardFooter>
    </Card>
  );
}
