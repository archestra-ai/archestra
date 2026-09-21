"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  type BatteryMatch,
  useBatteryMatches,
  useSetBatteryEnabled,
} from "@/lib/openappa-batteries.query";

/**
 * "Add to APPA" checkboxes for the guardrails batteries a catalog entry stands
 * for. A server matched by host or image is on by default; one matched by name
 * alone is off until someone turns it on.
 */
export function CatalogBatteryToggles({ catalogId }: { catalogId: string }) {
  const openappaEnabled = useFeature("openappaEnabled") === true;
  const {
    data: matches,
    isError,
    refetch,
  } = useBatteryMatches(catalogId, openappaEnabled);
  const { data: canManage } = useHasPermissions({
    organization: ["update"],
    toolPolicy: ["update"],
  });
  const setEnabled = useSetBatteryEnabled(catalogId);
  // A failed lookup must not read as "no battery applies".
  if (isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        <span>Could not check which guardrails batteries apply. </span>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => refetch()}
        >
          Retry
        </Button>
      </p>
    );
  if (!matches?.length) return null;
  return (
    <div className="space-y-2 rounded-md border p-3">
      {matches.map((match) => {
        const id = `battery-${match.battery}`;
        return (
          <div key={match.battery} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={match.install?.enabled ?? match.evidence !== "name"}
              disabled={canManage !== true || setEnabled.isPending}
              onCheckedChange={(checked) =>
                setEnabled.mutate({ match, enabled: checked === true })
              }
            />
            <div>
              <Label htmlFor={id} className="font-normal">
                Add the {match.battery} guardrails battery (APPA)
              </Label>
              <p className="text-muted-foreground">
                <span>{describe(match)} </span>
                {match.install?.status === "missing_credentials" ? (
                  <Link
                    href="/openappa"
                    className="underline underline-offset-4"
                  >
                    Bind a credential
                  </Link>
                ) : null}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type InstallStatus = NonNullable<BatteryMatch["install"]>["status"];

const STATUS_NOTES: Record<InstallStatus, string> = {
  active: "Its guardrails apply to this server's tools.",
  missing_credentials: "Needs a credential before its helpers can run.",
  naming_conflict: "Off: its tool names clash with another battery.",
  server_missing: "Off: it is bound to no server this deployment carries.",
  refused: "Off: the policy it composes into was refused.",
  unavailable: "Off: the battery package is gone.",
};

const EVIDENCE_NOTES: Record<BatteryMatch["evidence"], string> = {
  host: "Matched by the server's host. Applies once its tools are synced.",
  image: "Matched by the server's image. Applies once its tools are synced.",
  name: "Matched by name only, so it stays off unless you turn it on.",
};

function describe(match: BatteryMatch): string {
  return match.install
    ? STATUS_NOTES[match.install.status]
    : EVIDENCE_NOTES[match.evidence];
}
