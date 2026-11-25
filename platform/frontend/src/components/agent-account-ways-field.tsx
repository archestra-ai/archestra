"use client";

import { type ReactNode, useId, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import type { AgentRuntimeAccountLock } from "@/lib/agent-runtime-account.query";
import { cn } from "@/lib/utils/tailwind";

export type AgentAccountLock = AgentRuntimeAccountLock;

/** A way an agent's runs can be paid for. */
export type AccountWay = "subscription" | "provider";

/**
 * The ways a stored lock leaves open. No lock leaves both. The company key
 * way is the agent's own connection and model, so its lock is `key`.
 */
export function accountWays(
  lock: AgentAccountLock | null,
): Record<AccountWay, boolean> {
  return {
    subscription: lock === null || lock === "subscription",
    provider: lock !== "subscription",
  };
}

/**
 * The lock after one card is clicked, or "none" when the click leaves no way
 * ticked, which no lock can say: the form holds that until one is ticked
 * again. Ticking the missing way unlocks the agent; unticking one of two
 * locks it to the other.
 */
export function toggleAccountWay(
  lock: AgentAccountLock | null,
  way: AccountWay,
): AgentAccountLock | null | "none" {
  const ways = accountWays(lock);
  if (!ways[way]) return null;
  const other: AccountWay =
    way === "subscription" ? "provider" : "subscription";
  if (!ways[other]) return "none";
  return lockToWay(other);
}

/** The lock that leaves only `way` open. */
export function lockToWay(way: AccountWay): AgentAccountLock {
  return way === "subscription" ? "subscription" : "key";
}

/** One account an agent's runs can use, as a card of the account section. */
export type AccountOption = {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  /** What the account needs set up, shown in its card while it is on. */
  children?: ReactNode;
};

/**
 * The accounts that can run an agent, one card each. With several, each card
 * is ticked or not and holds its setup while ticked. With one, there is
 * nothing to tick: the card is always on.
 */
export function AgentAccountOptions({
  label,
  meaning,
  options,
  readOnly = false,
  problem,
}: {
  /** Accessible name of the group. */
  label: string;
  /** What the ticked options amount to, under the section's heading. */
  meaning?: string;
  options: AccountOption[];
  /** The viewer may not change the options: the cards only show the state. */
  readOnly?: boolean;
  /** Why the current combination cannot be saved yet. */
  problem?: string | null;
}) {
  const id = useId();
  // The validation message waits for the first click: a new agent's untouched
  // cards ask, they do not complain.
  const [touched, setTouched] = useState(false);
  const only = options.length === 1 ? options[0] : null;
  const noneSelected = !only && options.every((option) => !option.checked);
  return (
    <div className="space-y-2">
      {meaning && !only && (
        <FieldDescription id={`${id}-meaning`}>{meaning}</FieldDescription>
      )}
      {/* One card per option. The card's head is the option itself; while it
          is on, what it needs set up sits in the same card, under a hairline,
          so nothing belonging to one option reads as another's. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would nest inside the form's own fieldsets, which disable their descendants. */}
      <div role="group" aria-label={label} className="flex flex-col gap-3">
        {options.map((option) => {
          const text = (
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">{option.title}</span>
              <span className="block text-[13px] leading-[1.45] text-muted-foreground">
                {option.description}
              </span>
            </span>
          );
          return (
            <div
              key={option.id}
              // A plain bordered surface, like the form's other groups: the
              // checkbox alone says which options are on.
              className="overflow-hidden rounded-[10px] border bg-raised"
            >
              {only ? (
                <div className="p-3.5">{text}</div>
              ) : (
                <Label
                  htmlFor={`${id}-${option.id}`}
                  className={cn(
                    "flex items-start gap-2.5 p-3.5 font-normal",
                    // The focus ring stays on the head: a ring on the whole
                    // card would light up for every control inside it.
                    "ring-inset has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    readOnly ? "cursor-default" : "cursor-pointer",
                  )}
                >
                  <Checkbox
                    id={`${id}-${option.id}`}
                    checked={option.checked}
                    // Read-only keeps the box focusable so its state can be
                    // read; a disabled box could not say why it does not
                    // change.
                    aria-readonly={readOnly || undefined}
                    aria-describedby={meaning ? `${id}-meaning` : undefined}
                    onCheckedChange={() => {
                      if (readOnly) return;
                      setTouched(true);
                      option.onToggle();
                    }}
                    className="mt-0.5"
                  />
                  {text}
                </Label>
              )}
              {(only || option.checked) && option.children ? (
                // Aligned with the title. An option whose setup has nothing
                // to show right now has no body.
                <div
                  className={cn(
                    "min-w-0 space-y-3 border-t p-3.5 empty:hidden",
                    !only && "sm:pl-10",
                  )}
                >
                  {option.children}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {noneSelected &&
        (touched ? (
          <AccountSectionError>Select at least one option.</AccountSectionError>
        ) : (
          // An untouched new agent asks; it does not complain yet.
          <p className="text-xs text-muted-foreground">
            Select at least one option.
          </p>
        ))}
      {problem && <AccountSectionError>{problem}</AccountSectionError>}
    </div>
  );
}

/**
 * The two ways an agent's runs can be paid for, each person's subscription
 * and a company API key, as account options: both ticked lets each person
 * choose, one ticked locks the agent to that way.
 */
export function AgentAccountWays({
  label,
  subscription,
  provider,
  lock,
  noneSelected = false,
  onLockChange,
  onNoneSelected,
  readOnly = false,
  problem,
  chooser = "person",
}: {
  /** Accessible name of the group. */
  label: string;
  /** `children` is what that way needs set up, shown in its card while ticked. */
  subscription: { title: string; description: string; children?: ReactNode };
  provider: { title: string; description: string; children?: ReactNode };
  lock: AgentAccountLock | null;
  /**
   * Neither way is ticked: a new agent nobody has chosen for yet, or both
   * unticked in this edit. The form cannot be saved like this.
   */
  noneSelected?: boolean;
  onLockChange: (lock: AgentAccountLock | null) => void;
  /** The last ticked way was unticked. */
  onNoneSelected: () => void;
  /** The viewer may not change who chooses: the cards only show the state. */
  readOnly?: boolean;
  /** Why the current combination cannot be saved yet. */
  problem?: string | null;
  /** Who chooses while both ways are open; see `accountWaysMeaning`. */
  chooser?: AccountChooser;
}) {
  const ways = noneSelected
    ? { subscription: false, provider: false }
    : accountWays(lock);
  const toggle = (way: AccountWay) => {
    // A tick with nothing selected opens that way alone.
    if (noneSelected) {
      onLockChange(lockToWay(way));
      return;
    }
    const next = toggleAccountWay(lock, way);
    if (next === "none") onNoneSelected();
    else onLockChange(next);
  };
  return (
    <AgentAccountOptions
      label={label}
      meaning={accountWaysMeaning(ways, undefined, chooser)}
      options={[
        {
          id: "subscription",
          ...subscription,
          checked: ways.subscription,
          onToggle: () => toggle("subscription"),
        },
        {
          id: "provider",
          ...provider,
          checked: ways.provider,
          onToggle: () => toggle("provider"),
        },
      ]}
      readOnly={readOnly}
      problem={problem}
    />
  );
}

/**
 * Who chooses while both ways are open. On an agent each person chooses for
 * their own runs, on the agent's page. On a runtime's settings the people
 * who create or edit an agent on it choose what that agent allows.
 */
export type AccountChooser = "person" | "agent";

/** What the ticked ways amount to, for the line under the section's heading. */
export function accountWaysMeaning(
  ways: Record<AccountWay, boolean>,
  /** What the company's way is called where it is not an API key. */
  company = "a company API key",
  chooser: AccountChooser = "person",
): string {
  return ways.subscription && ways.provider
    ? chooser === "agent"
      ? `People who create or edit an agent on this runtime choose whether it allows personal subscriptions, ${company}, or both.`
      : `Each person who runs this agent chooses their own subscription or ${company} on the agent's page.`
    : ways.subscription
      ? "Locked to each user's personal subscription"
      : ways.provider
        ? `Locked to ${company}`
        : "Selecting more than one option allows users to choose.";
}

/**
 * What keeps this section from being saved, as one line of red text: the only
 * way the section reports an error.
 */
export function AccountSectionError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}
