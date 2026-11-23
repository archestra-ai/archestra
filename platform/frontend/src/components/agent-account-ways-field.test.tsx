import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  type AccountOption,
  AgentAccountOptions,
  accountWays,
  accountWaysMeaning,
  lockToWay,
  toggleAccountWay,
} from "./agent-account-ways-field";

describe("accountWays", () => {
  it("leaves both ways open without a lock and one way under each lock", () => {
    expect(accountWays(null)).toEqual({ subscription: true, provider: true });
    expect(accountWays("subscription")).toEqual({
      subscription: true,
      provider: false,
    });
    expect(accountWays("key")).toEqual({ subscription: false, provider: true });
  });
});

describe("toggleAccountWay", () => {
  it("locks the agent to the other way when one of two is unticked", () => {
    // The company key way is the agent's own connection, so its lock is `key`.
    expect(toggleAccountWay(null, "subscription")).toBe("key");
    expect(toggleAccountWay(null, "provider")).toBe("subscription");
  });

  it("unlocks the agent when the missing way is ticked", () => {
    expect(toggleAccountWay("subscription", "provider")).toBeNull();
    expect(toggleAccountWay("key", "subscription")).toBeNull();
  });

  it("leaves none selected when the last way is unticked", () => {
    expect(toggleAccountWay("subscription", "subscription")).toBe("none");
    expect(toggleAccountWay("key", "provider")).toBe("none");
  });
});

describe("lockToWay", () => {
  it("names the lock that leaves only that way open", () => {
    for (const way of ["subscription", "provider"] as const) {
      expect(accountWays(lockToWay(way))).toEqual({
        subscription: way === "subscription",
        provider: way === "provider",
      });
    }
  });
});

describe("accountWaysMeaning", () => {
  it("says what the ticked ways amount to", () => {
    const both = { subscription: true, provider: true };
    const companyOnly = { subscription: false, provider: true };
    expect(accountWaysMeaning(both)).toBe(
      "Each person chooses between their own subscription and a company API key.",
    );
    expect(accountWaysMeaning(companyOnly)).toBe("Locked to a company API key");
    expect(accountWaysMeaning({ subscription: true, provider: false })).toBe(
      "Locked to each user's personal subscription",
    );
    expect(accountWaysMeaning({ subscription: false, provider: false })).toBe(
      "Selecting more than one option allows users to choose.",
    );
  });

  it("names each agent as the one that chooses on a runtime's settings, and says the rest the same", () => {
    const ways = (subscription: boolean, provider: boolean) => ({
      subscription,
      provider,
    });
    expect(accountWaysMeaning(ways(true, true), "agent")).toBe(
      "Each agent chooses between personal subscriptions and a company API key.",
    );
    // Only the sentence for both differs from an agent's own settings.
    for (const one of [
      ways(true, false),
      ways(false, true),
      ways(false, false),
    ]) {
      expect(accountWaysMeaning(one, "agent")).toBe(accountWaysMeaning(one));
    }
  });
});

describe("AgentAccountOptions", () => {
  const option = (
    id: string,
    extra: Partial<AccountOption> = {},
  ): AccountOption => ({
    id,
    title: `Account ${id}`,
    description: `What account ${id} is`,
    checked: false,
    onToggle: () => {},
    children: <p>{`Setup of ${id}`}</p>,
    ...extra,
  });

  /** Options that tick and untick, as a form holding them would. */
  function Options({ ids }: { ids: string[] }) {
    const [checked, setChecked] = useState<string[]>([]);
    return (
      <AgentAccountOptions
        label="Accounts that can run it"
        meaning="What the ticks amount to"
        options={ids.map((id) =>
          option(id, {
            checked: checked.includes(id),
            onToggle: () =>
              setChecked((current) =>
                current.includes(id)
                  ? current.filter((entry) => entry !== id)
                  : [...current, id],
              ),
          }),
        )}
      />
    );
  }

  it("shows a single account as always on: its setup without a tick, a meaning or a request to select", () => {
    render(
      <AgentAccountOptions
        label="Accounts that can run it"
        meaning="What the ticks amount to"
        // Not ticked by whoever holds it: one account cannot be left out.
        options={[option("a")]}
      />,
    );
    const group = screen.getByRole("group", {
      name: "Accounts that can run it",
    });
    expect(within(group).getByText("Account a")).toBeVisible();
    expect(within(group).getByText("Setup of a")).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.queryByText("What the ticks amount to"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Select at least one option."),
    ).not.toBeInTheDocument();
  });

  it("shows each of several accounts' setup only while it is ticked, and asks for one when none is", async () => {
    const user = userEvent.setup();
    render(<Options ids={["a", "b"]} />);
    const tick = (id: string) =>
      screen.getByRole("checkbox", { name: new RegExp(`^Account ${id}`) });

    expect(screen.getByText("What the ticks amount to")).toBeVisible();
    expect(tick("a")).not.toBeChecked();
    expect(tick("b")).not.toBeChecked();
    expect(screen.queryByText(/^Setup of/)).not.toBeInTheDocument();
    // Untouched, it asks; it does not complain yet.
    expect(screen.getByText("Select at least one option.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(tick("a"));
    expect(screen.getByText("Setup of a")).toBeVisible();
    expect(screen.queryByText("Setup of b")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Select at least one option."),
    ).not.toBeInTheDocument();

    // Unticking the last one is an error now that the cards were touched.
    await user.click(tick("a"));
    expect(screen.queryByText("Setup of a")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Select at least one option.",
    );
  });

  it("shows the state without changing it for someone who may not change the accounts", async () => {
    const user = userEvent.setup();
    let toggles = 0;
    render(
      <AgentAccountOptions
        label="Accounts that can run it"
        readOnly
        problem="Choose a connection and model for the company API key."
        options={[
          option("a", { checked: true, onToggle: () => toggles++ }),
          option("b", { onToggle: () => toggles++ }),
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: /^Account b/ }));
    await user.click(screen.getByRole("checkbox", { name: /^Account a/ }));
    expect(toggles).toBe(0);
    // What keeps the section from being saved is its one red line.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose a connection and model for the company API key.",
    );
  });
});
