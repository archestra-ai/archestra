// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  ENVIRONMENT_DEPLOY_KIND_LABELS,
  ENVIRONMENT_DEPLOY_KINDS,
  type EnvironmentDeployKind,
} from "@archestra/shared";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Which kinds of object a limited environment grant deploys. The last kind
 * cannot be cleared: a grant that deploys nothing is "Can read", chosen from
 * the level list. Checking every kind is "Can use", which the caller stores.
 */
export function EnvironmentDeployKindsPicker({
  value,
  onChange,
  grantable,
  ariaLabel,
  disabled,
  open,
  onOpenChange,
}: {
  value: readonly EnvironmentDeployKind[];
  onChange: (kinds: EnvironmentDeployKind[]) => void;
  /** The kinds the viewer may hand on. A kind outside it can only be cleared. */
  grantable: readonly EnvironmentDeployKind[];
  ariaLabel: string;
  disabled?: boolean;
  /**
   * Held by the caller: a grant row is rebuilt when its actions change, and
   * the list has to stay open across that so several kinds take one visit.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          aria-label={ariaLabel}
          className="max-w-48 font-normal text-muted-foreground"
        >
          <span className="truncate">{deployKindsSummary(value)}</span>
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Can deploy</DropdownMenuLabel>
        {ENVIRONMENT_DEPLOY_KINDS.map((kind) => {
          const checked = value.includes(kind);
          return (
            <DropdownMenuCheckboxItem
              key={kind}
              checked={checked}
              disabled={
                checked ? value.length === 1 : !grantable.includes(kind)
              }
              // Choosing a kind does not close the list.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(next) =>
                onChange(
                  ENVIRONMENT_DEPLOY_KINDS.filter((candidate) =>
                    candidate === kind ? next : value.includes(candidate),
                  ),
                )
              }
            >
              {ENVIRONMENT_DEPLOY_KIND_LABELS[kind]}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The kinds by name, in the order the list shows them. */
export function deployKindsSummary(
  kinds: readonly EnvironmentDeployKind[],
): string {
  return ENVIRONMENT_DEPLOY_KINDS.filter((kind) => kinds.includes(kind))
    .map((kind) => ENVIRONMENT_DEPLOY_KIND_LABELS[kind])
    .join(", ");
}
