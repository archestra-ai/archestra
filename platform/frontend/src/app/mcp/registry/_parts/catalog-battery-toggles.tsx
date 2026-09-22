"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  type BatteryMatch,
  useBatteries,
  useBatteryMatches,
  useSetBatteryEnabled,
} from "@/lib/openappa-batteries.query";

/**
 * "Add to APPA" checkboxes for the guardrails batteries a catalog entry stands
 * for. Every box is off until someone turns it on, whatever the match's
 * evidence; turning it on is what includes the battery in the policy.
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
  // Binding a credential hands its value to helper code, so it takes its own
  // permission: whoever adds the battery here may not be able to finish it.
  const { data: canBindCredentials } = useHasPermissions({
    credential: ["update"],
  });
  const batteries = useBatteries(openappaEnabled);
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
        // Until the battery list answers, whether this one reads a credential
        // is unknown; a failed list is treated as if it does.
        const declaresCredentials = batteries.data
          ? (batteries.data.find((battery) => battery.name === match.battery)
              ?.credentials.length ?? 0) > 0
          : batteries.isError;
        const credentialIsSomeoneElses =
          declaresCredentials && canBindCredentials !== true;
        // The alias points at the server's tool prefix, which exists once its
        // tools are synced; the attach is refused before that.
        const unsynced = match.install === null && match.targets.length === 0;
        return (
          <div key={match.battery} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={match.install?.enabled ?? false}
              disabled={
                canManage !== true ||
                unsynced ||
                setEnabled.isPending ||
                batteries.isLoading
              }
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
                {match.install?.status === "missing_credentials" &&
                !credentialIsSomeoneElses ? (
                  <Link
                    href="/openappa"
                    className="underline underline-offset-4"
                  >
                    Bind a credential
                  </Link>
                ) : null}
              </p>
              {unsynced ? (
                <p role="note" className="text-muted-foreground">
                  Sync the server's tools first: the battery attaches to their
                  prefix.
                </p>
              ) : null}
              {credentialIsSomeoneElses ? (
                <p role="note" className="text-muted-foreground">
                  <span>
                    The box adds the battery, but its helpers stay idle until
                    someone with the credential permission binds its credential.{" "}
                  </span>
                  <Link
                    href="/openappa"
                    className="underline underline-offset-4"
                  >
                    See its credentials
                  </Link>
                </p>
              ) : null}
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
  host: "Matched by the server's host. Off until you turn it on.",
  image: "Matched by the server's image. Off until you turn it on.",
  name: "Matched by name only. Off until you turn it on.",
};

function describe(match: BatteryMatch): string {
  return match.install
    ? STATUS_NOTES[match.install.status]
    : EVIDENCE_NOTES[match.evidence];
}
