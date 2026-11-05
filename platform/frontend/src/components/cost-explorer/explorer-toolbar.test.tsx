import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { ChartKindToggle, QueryChip } from "./cost-explorer-parts";
import { ExplorerToolbar } from "./explorer-toolbar";

it("keeps the drill-down visible while mobile controls open in the funnel popover", async () => {
  vi.stubGlobal("innerWidth", 390);
  function Example() {
    const [metric, setMetric] = useState("Billed spend");
    const [model, setModel] = useState<string | undefined>("example/model");
    return (
      <ExplorerToolbar
        model={model}
        onClearModel={() => setModel(undefined)}
        summary={`${metric} by client`}
        controls={
          <QueryChip
            label="Show"
            value={metric}
            onChange={setMetric}
            options={[
              { id: "Billed spend", label: "Billed spend" },
              { id: "Requests", label: "Requests" },
            ]}
          />
        }
        chartType={<ChartKindToggle value="bars" onChange={() => {}} />}
      />
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  expect(
    screen.getByRole("navigation", { name: "Model drill-down" }),
  ).toHaveTextContent("example/model");
  expect(
    screen.queryByRole("button", { name: "Show Billed spend" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Chart options" }));
  const dialog = screen.getByRole("dialog", { name: "Chart options" });
  await user.click(
    within(dialog).getByRole("button", { name: "Show Billed spend" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Requests" }));
  expect(screen.getByText("Requests by client")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("dialog", { name: "Chart options" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Clear model filter" }));
  expect(
    screen.queryByRole("navigation", { name: "Model drill-down" }),
  ).not.toBeInTheDocument();
});
