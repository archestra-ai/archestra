"use client";

import { useState } from "react";
import { filterControlClass } from "@/components/filter-bar";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";

/**
 * Whether a `providerApiKeyId` query param is worth sending to the API.
 *
 * The list endpoints validate the param as a UUID and reject anything else with
 * a 400, and both tables render a load-error panel *above* which no filter bar
 * exists — so a hand-mangled URL would otherwise strand the user on a dead-end
 * error screen with no way to clear the filter. Guarding here is the same shape
 * the sibling `keyType` / `scope` / `grantType` params already use: an
 * unrecognised value reads as "no filter".
 *
 * A well-formed id that matches nothing is deliberately *not* filtered out —
 * that one belongs to the server, which answers with an empty page the table
 * can explain and offer to clear.
 */
export function isProviderApiKeyId(value: string | null): value is string {
  return (
    value !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

/**
 * The "Filter by provider key" control used by the Virtual Keys and OAuth
 * Clients tables. `value` is an LLM provider API key id, or `undefined` for
 * "not filtered"; `onValueChange` reports `null` when the filter is cleared,
 * which is what the query-param helpers already treat as "drop it".
 *
 * The dropdown itself is the shared {@link LlmProviderApiKeyDropdown} every
 * other provider-key picker uses, so this list stays grouped the same way
 * (personal subscriptions apart from API keys, then by provider) and picks up
 * changes to that grouping for free. This wrapper only supplies the pieces a
 * filter needs: the fetch, the "all" option, and the filter-bar trigger
 * styling.
 *
 * Deleting a provider key is blocked while virtual keys or OAuth clients still
 * map to it, and that blocking dialog links here with the key preselected — so
 * this control has to be able to name a key it was handed, not only one the
 * user picked from the list.
 */
export function ProviderKeyFilterSelect({
  value,
  onValueChange,
}: {
  value: string | undefined;
  onValueChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  // Errors stay silent: this is a filter next to a table that renders its own
  // load state, and a provider-key list we could not read costs the user the
  // dropdown's contents, not the page.
  const { data: providerApiKeys = [], isPending } = useLlmProviderApiKeys({
    toastOnError: false,
  });

  const selectedIsListed = providerApiKeys.some((key) => key.id === value);

  return (
    <LlmProviderApiKeyDropdown
      availableKeys={providerApiKeys}
      selectedApiKeyId={value ?? null}
      open={open}
      onOpenChange={setOpen}
      onSelectKey={(keyId) => {
        onValueChange(keyId);
        setOpen(false);
      }}
      allOptionLabel="All provider keys"
      allOptionSelected={value === undefined}
      onSelectAllOption={() => {
        onValueChange(null);
        setOpen(false);
      }}
      // A key we cannot resolve — deleted since the link was made, or not
      // readable by this user — still needs a name. The dropdown's own default
      // ("Select provider key...") would claim nothing is filtered while the
      // table quietly is. Left undefined otherwise, so the "all" label and a
      // resolved key's own name both still win.
      emptyTriggerLabel={
        value !== undefined && !selectedIsListed
          ? isPending
            ? "Loading provider key..."
            : "Unknown provider key"
          : undefined
      }
      triggerVariant="select"
      triggerAriaLabel="Filter by provider key"
      triggerClassName={filterControlClass({ active: value !== undefined })}
      popoverClassName="w-80"
      searchPlaceholder="Search provider keys..."
    />
  );
}
