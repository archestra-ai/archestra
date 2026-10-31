import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { agentRuntimeTiersSeed } from "@/mocks/data/organization";
import { RuntimeTierDialog } from "./runtime-tier-dialog";

describe("RuntimeTierDialog", () => {
  it("creates a tier once its fields are valid, and names what is wrong until then", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <RuntimeTierDialog
        open
        onOpenChange={() => {}}
        tier={null}
        tiers={agentRuntimeTiersSeed}
        onSave={onSave}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Create tier" });
    const submit = within(dialog).getByRole("button", { name: "Create tier" });
    await user.click(submit);
    expect(within(dialog).getByText("Enter a name")).toBeVisible();
    expect(
      within(dialog).getByText("Enter a number from 0.1 to 8"),
    ).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText("Name"), "XL");
    await user.type(within(dialog).getByLabelText("CPU request"), "8");
    expect(within(dialog).queryByText("Enter a name")).not.toBeInTheDocument();
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onSave).toHaveBeenCalledWith({
      tiers: [
        { name: "S", cpuRequest: 2, cpuLimit: null, pooled: true },
        { name: "M", cpuRequest: 4, cpuLimit: null, pooled: true },
        { name: "L", cpuRequest: 8, cpuLimit: null, pooled: false },
        { name: "XL", cpuRequest: 8, cpuLimit: null, pooled: true },
      ],
      defaultTier: "M",
    });
  });

  it("shows an example in each empty field and explains pooling on request", async () => {
    const user = userEvent.setup();
    render(
      <RuntimeTierDialog
        open
        onOpenChange={() => {}}
        tier={null}
        tiers={agentRuntimeTiersSeed}
        onSave={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Create tier" });
    expect(within(dialog).getByLabelText("Name")).toHaveAttribute(
      "placeholder",
      "XL",
    );
    expect(within(dialog).getByLabelText("CPU request")).toHaveAttribute(
      "placeholder",
      "4",
    );
    expect(within(dialog).getByLabelText("CPU limit")).toHaveAttribute(
      "placeholder",
      "No limit",
    );
    expect(
      within(dialog).getByRole("switch", { name: "Pooled" }),
    ).toBeChecked();
    await user.hover(
      within(dialog).getByRole("button", { name: "About pooled tiers" }),
    );
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      "Agent runs start much quicker from pool of runtime instances. Managed automatically. Pooled instances reserve part of cluster's capacity. Learn more",
    );
    expect(
      within(tooltip).getByRole("link", { name: /Learn more/ }),
    ).toHaveAttribute(
      "href",
      expect.stringMatching(/\/docs\/agents\/runtime\/setup#warm-pools$/),
    );
  });

  it("keeps a server refusal in the dialog", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(
        new Error("Tier L is the default or scaleup tier of 1 agent"),
      );
    const user = userEvent.setup();
    render(
      <RuntimeTierDialog
        open
        onOpenChange={() => {}}
        tier={agentRuntimeTiersSeed.tiers[2]}
        tiers={agentRuntimeTiersSeed}
        onSave={onSave}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit tier" });
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Tier L is the default or scaleup tier of 1 agent",
    );
  });
});
