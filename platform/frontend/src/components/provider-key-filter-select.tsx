"use client";

import type { SupportedProvider } from "@archestra/shared";
import { FilterSelect } from "@/components/filter-bar";
import { ProviderIcon } from "@/components/provider-icon";
import { DEFAULT_FILTER_ALL } from "@/consts";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
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
 * The shared "Filter by provider key" dropdown used by the Virtual Keys and
 * OAuth Clients tables. `value` is an LLM provider API key id, or `undefined`
 * for "not filtered"; `onValueChange` reports `null` when the filter is
 * cleared, which is what the query-param helpers already treat as "drop it".
 * The "all" sentinel the underlying select needs stays in here — call sites
 * deal in ids and absence.
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
  const providerCatalog = useModelProviderCatalog();
  // Errors stay silent: this is a filter next to a table that renders its own
  // load state, and a provider-key list we could not read costs the user the
  // dropdown's contents, not the page.
  const { data: providerApiKeys = [], isPending } = useLlmProviderApiKeys({
    toastOnError: false,
  });

  const selectedIsListed = providerApiKeys.some((key) => key.id === value);

  return (
    <FilterSelect
      value={value ?? DEFAULT_FILTER_ALL}
      onValueChange={(next) =>
        onValueChange(next === DEFAULT_FILTER_ALL ? null : next)
      }
      placeholder="Filter by provider key"
      searchPlaceholder="Search provider keys..."
      emptyMessage="No provider keys found."
      items={[
        { value: DEFAULT_FILTER_ALL, label: "All provider keys" },
        ...providerApiKeys.map((key) => ({
          value: key.id,
          label: key.name,
          // So typing a provider ("anthropic") finds its keys, even though the
          // option is labelled by the key's own name.
          searchText: `${key.name} ${providerCatalog.label(key.provider)}`,
          content: (
            <ProviderKeyOption name={key.name} provider={key.provider} />
          ),
          selectedContent: (
            <ProviderKeyOption name={key.name} provider={key.provider} />
          ),
        })),
        // A key we cannot resolve — deleted since the link was made, or not
        // readable by this user — still needs a name here. Without one the
        // trigger falls back to rendering the raw id, and the bar would claim
        // nothing is filtered while the table quietly is.
        ...(value !== undefined && !selectedIsListed
          ? [
              {
                value,
                label: isPending
                  ? "Loading provider key..."
                  : "Unknown provider key",
              },
            ]
          : []),
      ]}
    />
  );
}

function ProviderKeyOption({
  name,
  provider,
}: {
  name: string;
  provider: SupportedProvider;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ProviderIcon provider={provider} />
      <span className="truncate">{name}</span>
    </span>
  );
}
