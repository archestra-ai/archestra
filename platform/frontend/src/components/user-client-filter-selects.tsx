"use client";

import { CLIENT_FILTER_OPTIONS, type ClientFilter } from "@archestra/shared";
import { FilterSelect, filterControlClass } from "@/components/filter-bar";
import { ClientFilterOption } from "@/components/log-filter-option";
import { RemoteUserSelect } from "@/components/remote-user-select";
import { DEFAULT_FILTER_ALL } from "@/consts";

/**
 * The shared "Filter by User" picker used by the LLM and MCP logs pages.
 * `value` is a user id or the "all" sentinel (DEFAULT_FILTER_ALL). `source`
 * picks the users offered: users with LLM logs, or organization members.
 */
export function UserFilterSelect({
  value,
  onValueChange,
  source,
}: {
  value: string;
  onValueChange: (value: string) => void;
  source: "logs" | "members";
}) {
  return (
    <RemoteUserSelect
      value={value}
      onValueChange={onValueChange}
      placeholder="Filter by User"
      className={filterControlClass({ active: value !== DEFAULT_FILTER_ALL })}
      searchMode="name"
      source={source}
      pinnedOption={{ value: DEFAULT_FILTER_ALL, label: "All Users" }}
    />
  );
}

/**
 * The shared "Filter by Client" dropdown (Claude, Codex, …) used by the LLM
 * logs and Guardrails pages. `clients` restricts the options to the given
 * families; omitted, every known family is offered.
 */
export function ClientFilterSelect({
  value,
  onValueChange,
  clients,
}: {
  value: string;
  onValueChange: (value: string) => void;
  clients?: ClientFilter[];
}) {
  const options = clients
    ? CLIENT_FILTER_OPTIONS.filter((option) => clients.includes(option.value))
    : CLIENT_FILTER_OPTIONS;

  return (
    <FilterSelect
      value={value}
      onValueChange={onValueChange}
      placeholder="Filter by Client"
      items={[
        { value: DEFAULT_FILTER_ALL, label: "All Clients" },
        ...options.map(
          ({ value: optionValue, label, provider, icon, mark }) => ({
            value: optionValue,
            label,
            content: (
              <ClientFilterOption client={{ label, provider, icon, mark }} />
            ),
            selectedContent: (
              <ClientFilterOption client={{ label, provider, icon, mark }} />
            ),
          }),
        ),
      ]}
    />
  );
}
