"use client";

import { type FixedRole, fixedRoleGroups } from "@archestra/shared/fixed-roles";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Input } from "@/components/ui/input";
import { matchesSearchTokens } from "@/lib/search-tokens";

/**
 * The fixed roles, grouped the way the role picker groups them, as a
 * read-only reference: what each one is called, what it is for, and exactly
 * which permissions it carries. Each opens its own page, which lists who
 * holds it and can start a custom role from it.
 *
 * A list rather than the roles table: there are dozens of them, none can be
 * edited or deleted, and a reader scans them by area, not page by page.
 */
export function FixedRolesReference() {
  const [query, setQuery] = useState("");
  const groups = fixedRoleGroups
    .map((group) => ({
      ...group,
      roles: group.roles.filter((role) =>
        matchesSearchTokens(query, [
          role.name,
          role.role,
          role.description,
          group.name,
          ...permissionKeys(role),
        ]),
      ),
    }))
    .filter((group) => group.roles.length > 0);

  return (
    <div className="space-y-6">
      <CollectionFilters>
        <FilterBar
          onClearFilters={query ? () => setQuery("") : undefined}
          search={
            <Input
              aria-label="Search fixed roles"
              placeholder="Search fixed roles by name or permission"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={filterSearchClass}
            />
          }
        />
      </CollectionFilters>
      {groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No fixed roles match your search.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.id} aria-labelledby={`fixed-group-${group.id}`}>
            <h3
              id={`fixed-group-${group.id}`}
              className="mb-2 text-sm font-medium"
            >
              {group.name}
            </h3>
            <ul className="divide-y rounded-lg border">
              {group.roles.map((role) => (
                <li key={role.role}>
                  <IntentPrefetchLink
                    href={`/settings/roles/${encodeURIComponent(role.role)}`}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="text-sm font-medium">{role.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {role.description}
                      </div>
                    </div>
                    <div className="hidden max-w-[45%] flex-wrap justify-end gap-1 sm:flex">
                      {permissionKeys(role).map((key) => (
                        <code
                          key={key}
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                        >
                          {key}
                        </code>
                      ))}
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </IntentPrefetchLink>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

// === Internal helpers

function permissionKeys(role: FixedRole): string[] {
  return Object.entries(role.permission).flatMap(([resource, actions]) =>
    (actions ?? []).map((action) => `${resource}:${action}`),
  );
}
