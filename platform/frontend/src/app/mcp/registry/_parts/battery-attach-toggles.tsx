"use client";

import Link from "next/link";
import { OpenAppaIcon } from "@/components/openappa-icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  ATTACH_NOTES,
  type BatteryMatch,
  type BatteryServerAttachment,
  useBatteries,
  useBatteryMatches,
  useSetBatteryEnabled,
} from "@/lib/openappa-batteries.query";

/**
 * "Add to APPA" checkboxes for the guardrails batteries a server stands for:
 * a catalog entry, or a client's own detected server. Every box is off until
 * someone turns it on, whatever the match's evidence; turning it on is what
 * includes the battery in the policy.
 */
export function BatteryAttachToggles({
  attachment,
  emptyMessage,
}: {
  attachment: BatteryServerAttachment;
  /** Shown when no battery matches; nothing is shown without one. */
  emptyMessage?: string;
}) {
  const openappaEnabled = useFeature("openappaEnabled") === true;
  const { data, isError, refetch } = useBatteryMatches(
    attachment,
    openappaEnabled,
  );
  // The install routes take this permission; the checkbox follows them.
  const { data: canManage } = useHasPermissions({
    openappaPolicy: ["update"],
  });
  // Binding a credential hands its value to helper code, so it takes its own
  // permission: whoever adds the battery here may not be able to finish it.
  const { data: canBindCredentials } = useHasPermissions({
    credential: ["update"],
  });
  const batteries = useBatteries(openappaEnabled);
  const setEnabled = useSetBatteryEnabled(attachment);
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
  if (!data?.matches.length)
    return emptyMessage ? (
      <p className="text-sm text-muted-foreground">{emptyMessage}</p>
    ) : null;
  const attachNote = data.attach === "ready" ? null : ATTACH_NOTES[data.attach];
  return (
    <div className="space-y-2">
      {data.matches.map((match) => {
        const id = `battery-${match.battery}`;
        // Until the battery list answers, whether this one reads a credential
        // is unknown; a failed list is treated as if it does.
        const declaresCredentials = batteries.data
          ? (batteries.data.find((battery) => battery.name === match.battery)
              ?.credentials.length ?? 0) > 0
          : batteries.isError;
        const credentialIsSomeoneElses =
          declaresCredentials && canBindCredentials !== true;
        const checked = match.install?.enabled ?? false;
        // The alias points at the server's tool prefix. Turning the battery on
        // needs one an alias can take, and with no synced tools not even the
        // detach of a row that outlived its prefixes edits anything. The box
        // says why before it is tried.
        const blocked =
          data.attach === "unsynced" || (data.attach !== "ready" && !checked);
        return (
          <div key={match.battery} className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Checkbox
                id={id}
                checked={checked}
                disabled={
                  canManage !== true ||
                  blocked ||
                  setEnabled.isPending ||
                  batteries.isLoading
                }
                onCheckedChange={(checked) =>
                  setEnabled.mutate({ match, enabled: checked === true })
                }
              />
              <Label
                htmlFor={id}
                className="flex items-center gap-1.5 font-normal"
              >
                <OpenAppaIcon className="size-4" aria-hidden />
                <span>Add the {match.battery} guardrails battery</span>
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
            </div>
            {blocked ? (
              <p role="note" className="text-muted-foreground">
                {attachNote}
              </p>
            ) : null}
            {credentialIsSomeoneElses ? (
              <p role="note" className="text-muted-foreground">
                <span>
                  The box adds the battery, but its helpers stay idle until
                  someone with the credential permission binds its credential.{" "}
                </span>
                <Link href="/openappa" className="underline underline-offset-4">
                  See its credentials
                </Link>
              </p>
            ) : null}
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
  unrouted: "Composed, but no policy rule routes a tool to its annotators.",
  refused: "Off: the policy it composes into was refused.",
  unavailable: "Off: the battery package is gone.",
};

const EVIDENCE_NOTES: Record<BatteryMatch["evidence"], string> = {
  host: "Matched by the server's host.",
  image: "Matched by the server's image.",
  name: "Matched by name only.",
  tool: "Its rules name tools this server declares.",
};

function describe(match: BatteryMatch): string {
  return match.install
    ? STATUS_NOTES[match.install.status]
    : EVIDENCE_NOTES[match.evidence];
}
