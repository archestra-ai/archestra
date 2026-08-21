"use client";

import { CLIENT_FILTER_OPTIONS, type ClientFilter } from "@archestra/shared";
import { FilterSelect } from "@/components/filter-bar";
import {
  ClientFilterOption,
  UserFilterOption,
} from "@/components/log-filter-option";
import { DEFAULT_FILTER_ALL } from "@/consts";

/**
 * The shared "Filter by User" dropdown used by the LLM logs and Guardrails
 * pages. `value` is a user id or the "all" sentinel (DEFAULT_FILTER_ALL).
 */
export function UserFilterSelect({
  value,
  onValueChange,
  users,
}: {
  value: string;
  onValueChange: (value: string) => void;
  users: Array<{ id: string; name: string }> | undefined;
}) {
  return (
    <FilterSelect
      value={value}
      onValueChange={onValueChange}
      placeholder="Filter by User"
      items={[
        { value: DEFAULT_FILTER_ALL, label: "All Users" },
        ...(users?.map((user) => ({
          value: user.id,
          label: user.name || user.id,
          content: <UserFilterOption name={user.name || user.id} />,
          selectedContent: <UserFilterOption name={user.name || user.id} />,
        })) || []),
      ]}
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
        ...options.map(({ value: optionValue, label, provider, icon }) => ({
          value: optionValue,
          label,
          content: <ClientFilterOption client={{ label, provider, icon }} />,
          selectedContent: (
            <ClientFilterOption client={{ label, provider, icon }} />
          ),
        })),
      ]}
    />
  );
}
