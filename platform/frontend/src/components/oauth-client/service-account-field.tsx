"use client";

import { AlertTriangle, Bot, CircleSlash } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
  const {
    data: accounts = [],
    isLoading,
    isError,
    refetch,
  } = useServiceAccounts();
  const available = accounts.filter((account) => !account.disabled);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Service account (optional)</Label>
      <p id={`${id}-description`} className="text-xs text-muted-foreground">
        Choose the account whose permissions this client uses. Its runs and LLM
        spend are recorded under that account. Leave unset to keep runs separate
        for this OAuth client.
      </p>
      <SearchableSelect
        id={id}
        ariaLabel="Service account"
        aria-describedby={`${id}-description`}
        className="w-full"
        value={value ?? "none"}
        onValueChange={(selected) =>
          onChange(selected === "none" ? null : selected)
        }
        disabled={isLoading || isError}
        items={[
          ...available.map((account) => ({
            value: account.id,
            label: account.name,
            description: account.role
              ? `Roles: ${account.role.split(",").join(", ")}`
              : "Service account",
            content: (
              <span className="flex items-center gap-2">
                <Bot className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{account.name}</span>
              </span>
            ),
            selectedContent: (
              <span className="flex items-center gap-2">
                <Bot className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{account.name}</span>
              </span>
            ),
            searchText: `${account.name} ${account.role}`,
          })),
          ...(value && !available.some((account) => account.id === value)
            ? [{ value, label: "Current service account (unavailable)" }]
            : []),
        ]}
        pinnedItems={[
          {
            value: "none",
            label: "No service account",
            description: "A2A runs belong only to this OAuth client.",
            content: (
              <span className="flex items-center gap-2">
                <CircleSlash className="size-4 shrink-0 text-muted-foreground" />
                <span>No service account</span>
              </span>
            ),
          },
        ]}
        placeholder="Choose a service account"
        searchPlaceholder="Search service accounts…"
      />
      {isError && (
        <InlineNotice variant="error">
          <AlertTriangle />
          <InlineNoticeText>Could not load service accounts.</InlineNoticeText>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </InlineNotice>
      )}
    </div>
  );
}
