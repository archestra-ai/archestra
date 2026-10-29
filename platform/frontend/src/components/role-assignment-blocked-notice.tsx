// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type {
  RoleAssignmentBlockedDetails,
  ScopedResource,
} from "@archestra/shared";
import { ShieldX } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { resourcePluralNames } from "@/components/resource-permissions";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  parseRoleAssignmentBlocked,
  type RoleAssignmentBlockedError,
} from "@/lib/role-assignment-blocked";

/**
 * Explains a refused role or team assignment: which items the role or team
 * shares, and the permission the caller lacks on them. Renders nothing for
 * any other error, so a dialog can pass its mutation error straight in.
 */
export function RoleAssignmentBlockedNotice({
  error,
  name,
}: {
  error: unknown;
  /**
   * The role or team being assigned, as the dialog shows it. A dialog that
   * assigns both (a team's roles and its parent team) names each.
   */
  name: string | Partial<Record<"role" | "team", string>>;
}) {
  const blocked = parseRoleAssignmentBlocked(error);
  if (!blocked) return null;
  const { subjectType } = blocked.details;
  const label =
    (typeof name === "string" ? name : name[subjectType]) ||
    `this ${subjectType}`;
  return <Notice name={label} details={blocked.details} />;
}

/** Whether `error` is a refusal {@link RoleAssignmentBlockedNotice} explains. */
export function isRoleAssignmentBlocked(
  error: unknown,
): error is RoleAssignmentBlockedError {
  return parseRoleAssignmentBlocked(error) !== null;
}

// === internal helpers ===

type BlockedItem = RoleAssignmentBlockedDetails["items"][number];

function Notice({
  name,
  details,
}: {
  name: string;
  details: RoleAssignmentBlockedDetails;
}) {
  const subject = details.subjectType;
  const hidden = details.total - details.items.length;
  return (
    <InlineNotice variant="error" className="w-full" role="alert">
      <ShieldX />
      <span className="font-medium">Can’t assign {name}</span>
      <InlineNoticeText>
        Giving someone a {subject} also shares every item in that {subject}. You
        can only share an item if you can manage its permissions.
      </InlineNoticeText>
      <InlineNoticeText>
        You don’t have <Code>manage-permissions</Code> on{" "}
        {details.total === 1 ? "this item" : `these ${details.total} items`}.{" "}
        <Code>accessPolicies:update</Code> would let you assign any {subject}.
      </InlineNoticeText>
      <InlineNoticeText>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          {groupByResource(details.items).map((group) => (
            <Fragment key={group.resource}>
              <dt className="opacity-70">{group.label}:</dt>
              <dd>
                {group.items.map((item, index) => (
                  <Fragment key={item.scope}>
                    {index > 0 && <span>, </span>}
                    <Item item={item} />
                  </Fragment>
                ))}
              </dd>
            </Fragment>
          ))}
        </dl>
        {hidden > 0 && <p className="mt-0.5 opacity-70">and {hidden} more</p>}
      </InlineNoticeText>
    </InlineNotice>
  );
}

function Item({ item }: { item: BlockedItem }) {
  const label = item.name ?? `All ${resourcePluralNames[item.resource]}`;
  const href = item.scope === "*" ? null : itemHref(item);
  const className =
    "rounded-sm font-medium underline decoration-current/30 decoration-dotted underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-current/40";
  const trigger = href ? (
    <Link href={href} className={className}>
      {label}
    </Link>
  ) : (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the tooltip naming the missing permissions.
    <span tabIndex={0} className={className}>
      {label}
    </span>
  );
  if (item.missing.length === 0) return trigger;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top" className="flex items-center gap-1.5">
        <span>Missing</span>
        {item.missing.map((action) => (
          <Code key={action}>{action}</Code>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-current/10 px-1 font-mono text-[0.85em]">
      {children}
    </code>
  );
}

function groupByResource(items: BlockedItem[]) {
  const groups = new Map<
    ScopedResource,
    { resource: ScopedResource; label: string; items: BlockedItem[] }
  >();
  for (const item of items) {
    const plural = resourcePluralNames[item.resource];
    const group = groups.get(item.resource) ?? {
      resource: item.resource,
      label: plural.charAt(0).toUpperCase() + plural.slice(1),
      items: [],
    };
    group.items.push(item);
    groups.set(item.resource, group);
  }
  return [...groups.values()];
}

/** Detail pages that exist for one object; other kinds render as text. */
function itemHref(item: BlockedItem): string | null {
  const id = encodeURIComponent(item.scope);
  switch (item.resource) {
    case "agent":
      return `/agents/${id}`;
    case "mcpGateway":
      return `/mcp/gateways/${id}`;
    case "mcpRegistry":
      return `/mcp/registry/${id}`;
    case "knowledgeConnector":
      return `/knowledge/connectors/${id}`;
    case "skill":
      return `/skills/${id}`;
    case "project":
      return `/projects/${id}`;
    case "plugin":
      return `/plugins/${id}`;
    default:
      return null;
  }
}
