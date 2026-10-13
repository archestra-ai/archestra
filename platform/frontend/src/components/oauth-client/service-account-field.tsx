"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useServiceAccounts } from "@/lib/service-account.query";

export function OAuthServiceAccountField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const id = useId();
  const { data: accounts = [], isLoading, isError } = useServiceAccounts();
  const available = accounts.filter((account) => !account.disabled);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Act as service account</Label>
      <SearchableSelect
        id={id}
        ariaLabel="Act as service account"
        value={value ?? "none"}
        onValueChange={(selected) =>
          onChange(selected === "none" ? null : selected)
        }
        disabled={isLoading || isError}
        items={[
          ...available.map((account) => ({
            value: account.id,
            label: account.name,
          })),
          ...(value && !available.some((account) => account.id === value)
            ? [{ value, label: "Current service account (unavailable)" }]
            : []),
        ]}
        pinnedItems={[{ value: "none", label: "No service account" }]}
        placeholder="Choose a service account"
        searchPlaceholder="Search service accounts…"
      />
      <p className="text-sm text-muted-foreground">
        A2A runs belong to this account. Access follows its grants. Changing the
        account revokes issued OAuth tokens.
      </p>
    </div>
  );
}
