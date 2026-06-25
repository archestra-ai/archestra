"use client";

import {
  DocsPage,
  E2eTestId,
  getDocsUrl,
  getManageCredentialsAddToTeamOptionTestId,
} from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

type ServiceAccountTarget = { type: "team"; teamId: string } | { type: "org" };

const ORG_TARGET_VALUE = "__org__";

interface AddServiceAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Teams that don't yet have a service account for this server. */
  availableTeams: Array<{ id: string; name: string }>;
  /** Whether an organization-wide service account can still be added. */
  canAddOrg: boolean;
  onConfirm: (target: ServiceAccountTarget) => void;
}

export function AddServiceAccountDialog({
  open,
  onOpenChange,
  availableTeams,
  canAddOrg,
  onConfirm,
}: AddServiceAccountDialogProps) {
  const defaultValue = canAddOrg
    ? ORG_TARGET_VALUE
    : (availableTeams[0]?.id ?? null);
  const [selected, setSelected] = useState<string | null>(defaultValue);

  // Reset the choice whenever the dialog (re)opens or the option set changes,
  // so a stale selection from a previous open can't be submitted.
  useEffect(() => {
    if (open) {
      setSelected(
        canAddOrg ? ORG_TARGET_VALUE : (availableTeams[0]?.id ?? null),
      );
    }
  }, [open, canAddOrg, availableTeams]);

  const handleConfirm = () => {
    if (!selected) return;
    onConfirm(
      selected === ORG_TARGET_VALUE
        ? { type: "org" }
        : { type: "team", teamId: selected },
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Add a service account
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              This connection is shared. Use it with care.
            </p>
            <p>It gets used in two ways:</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                <span className="font-medium text-foreground">Static key</span>{" "}
                — when it's pinned as the server's single account, every call
                uses it no matter who is chatting.
              </li>
              <li>
                <span className="font-medium text-foreground">Fallback</span> —
                during on-behalf-of, when someone chatting has no connection of
                their own.
              </li>
            </ul>
            <p>
              Treat the credential like a shared secret.{" "}
              <ExternalDocsLink
                href={getDocsUrl(
                  DocsPage.McpAuthentication,
                  "resolve-at-call-time",
                )}
                className="underline"
                showIcon={false}
              >
                Learn more
              </ExternalDocsLink>
            </p>
          </div>

          {(availableTeams.length > 0 || canAddOrg) && (
            <div className="space-y-2">
              <Label>Who should own this service account?</Label>
              <RadioGroup
                value={selected ?? ""}
                onValueChange={setSelected}
                className="gap-2"
              >
                {canAddOrg && (
                  <Label
                    htmlFor="service-account-org"
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 font-normal has-[:checked]:border-primary"
                    data-testid={E2eTestId.ManageCredentialsAddToOrgButton}
                  >
                    <RadioGroupItem
                      id="service-account-org"
                      value={ORG_TARGET_VALUE}
                      className="mt-0.5"
                    />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">
                        Organization
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Everyone in the organization can use it.
                      </span>
                    </span>
                  </Label>
                )}
                {availableTeams.map((team) => (
                  <Label
                    key={team.id}
                    htmlFor={`service-account-team-${team.id}`}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 font-normal has-[:checked]:border-primary"
                    data-testid={getManageCredentialsAddToTeamOptionTestId(
                      team.name,
                    )}
                  >
                    <RadioGroupItem
                      id={`service-account-team-${team.id}`}
                      value={team.id}
                      className="mt-0.5"
                    />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">
                        {team.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Members of this team can use it.
                      </span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selected}
            onClick={handleConfirm}
            data-testid={E2eTestId.AddServiceAccountConfirmButton}
          >
            Add service account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
