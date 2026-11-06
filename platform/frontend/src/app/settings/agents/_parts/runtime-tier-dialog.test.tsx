import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { agentRuntimeTiersSeed } from "@/mocks/data/organization";
import { RuntimeTierDialog } from "./runtime-tier-dialog";

describe("RuntimeTierDialog", () => {
  it("saves the displayed name and numeric defaults when creation fields are blank", async () => {
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
    const dialog = within(screen.getByRole("dialog", { name: "Create tier" }));
    const name = dialog.getByLabelText("Name");
    const suggestion = name.getAttribute("placeholder");
    expect(suggestion).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(name).toHaveValue("");
    expect(dialog.getByLabelText("CPU request")).toHaveAttribute(
      "placeholder",
      "4",
    );
    expect(dialog.getByLabelText("Memory request (GiB)")).toHaveAttribute(
      "placeholder",
      "8",
    );
    expect(dialog.getByLabelText("Memory limit (GiB)")).toHaveAttribute(
      "placeholder",
      "16",
    );
    await user.type(name, "   ");
    expect(name).toHaveAttribute("placeholder", suggestion);
    await user.click(dialog.getByRole("checkbox", { name: "Default tier" }));
    await user.click(dialog.getByRole("button", { name: "Create tier" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        tiers: expect.arrayContaining([
          expect.objectContaining({
            name: suggestion,
            cpuRequest: 4,
            cpuLimit: null,
            memoryRequestMiB: null,
            memoryLimitMiB: null,
            workspaceGiB: null,
          }),
        ]),
        defaultTier: suggestion,
      }),
    );
  });

  it.each([
    "create",
    "edit",
  ] as const)("uses the displayed CPU default when blank on %s", async (mode) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <RuntimeTierDialog
        open
        onOpenChange={() => {}}
        tier={mode === "edit" ? agentRuntimeTiersSeed.tiers[0] : null}
        tiers={{ ...agentRuntimeTiersSeed, defaultTier: "S" }}
        onSave={onSave}
      />,
    );
    const dialog = within(screen.getByRole("dialog"));
    const cpu = dialog.getByLabelText("CPU request");
    await user.clear(cpu);
    expect(cpu).toHaveAttribute("placeholder", "2");
    expect(dialog.getByLabelText("Memory request (GiB)")).toHaveAttribute(
      "placeholder",
      "4",
    );
    expect(dialog.getByLabelText("Memory limit (GiB)")).toHaveAttribute(
      "placeholder",
      "8",
    );
    await user.click(
      dialog.getByRole("button", {
        name: mode === "edit" ? "Save changes" : "Create tier",
      }),
    );
    expect(onSave).toHaveBeenCalledOnce();
    const savedTiers = onSave.mock.calls[0][0].tiers;
    const savedTier =
      mode === "create"
        ? savedTiers.at(-1)
        : savedTiers.find((entry: { name: string }) => entry.name === "S");
    expect(savedTier).toMatchObject({ cpuRequest: 2 });
  });

  it("requires a name when editing an existing tier", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <RuntimeTierDialog
        open
        onOpenChange={() => {}}
        tier={agentRuntimeTiersSeed.tiers[0]}
        tiers={agentRuntimeTiersSeed}
        onSave={onSave}
      />,
    );
    const dialog = within(screen.getByRole("dialog", { name: "Edit tier" }));
    await user.clear(dialog.getByLabelText("Name"));
    await user.click(dialog.getByRole("button", { name: "Save changes" }));
    expect(dialog.getByText("Enter a name")).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
  });

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
    await user.type(within(dialog).getByLabelText("CPU request"), "0");
    await user.click(submit);
    expect(within(dialog).queryByText("Enter a name")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("Enter a number from 0.1 to 256"),
    ).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText("Name"), "XL");
    await user.clear(within(dialog).getByLabelText("CPU request"));
    await user.type(within(dialog).getByLabelText("CPU request"), "8");
    expect(
      within(dialog).getByLabelText("Memory request (GiB)"),
    ).toHaveAttribute("placeholder", "16");
    expect(within(dialog).getByLabelText("Memory limit (GiB)")).toHaveAttribute(
      "placeholder",
      "32",
    );
    expect(within(dialog).queryByText("Enter a name")).not.toBeInTheDocument();
    const workspace = within(dialog).getByLabelText("Disk (GiB)");
    await user.type(workspace, "1.5");
    await user.tab();
    expect(
      within(dialog).getByText(
        "Enter a positive whole number, or leave it blank for the default",
      ),
    ).toBeVisible();
    await user.clear(workspace);
    await user.type(workspace, "60");
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onSave).toHaveBeenCalledWith({
      tiers: [
        {
          name: "S",
          cpuRequest: 2,
          cpuLimit: null,
          pooled: true,
          workspaceGiB: null,
        },
        {
          name: "M",
          cpuRequest: 4,
          cpuLimit: null,
          pooled: true,
          workspaceGiB: null,
        },
        {
          name: "L",
          cpuRequest: 8,
          cpuLimit: null,
          pooled: false,
          workspaceGiB: null,
        },
        {
          name: "XL",
          cpuRequest: 8,
          cpuLimit: null,
          memoryRequestMiB: null,
          memoryLimitMiB: null,
          pooled: true,
          workspaceGiB: 60,
        },
      ],
      defaultTier: "M",
    });
  });

  it("saves independent memory with fractional CPU and restores derived memory when cleared", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <RuntimeTierDialog
        open
        onOpenChange={() => {}}
        tier={{
          ...agentRuntimeTiersSeed.tiers[0],
          memoryRequestMiB: 8192,
          memoryLimitMiB: 8192,
          memoryRequestMiBOverride: 8192,
          memoryLimitMiBOverride: 8192,
        }}
        tiers={agentRuntimeTiersSeed}
        onSave={onSave}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit tier" });
    expect(within(dialog).getByLabelText("Memory request (GiB)")).toHaveValue(
      8,
    );
    expect(within(dialog).getByLabelText("Memory limit (GiB)")).toHaveValue(8);
    const cpu = within(dialog).getByLabelText("CPU request");
    await user.clear(cpu);
    await user.type(cpu, "0.5");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(onSave.mock.calls[0][0].tiers[0]).toMatchObject({
      cpuRequest: 0.5,
      memoryRequestMiB: 8192,
      memoryLimitMiB: 8192,
    });
    await user.clear(within(dialog).getByLabelText("Memory request (GiB)"));
    await user.clear(within(dialog).getByLabelText("Memory limit (GiB)"));
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(onSave.mock.calls[1][0].tiers[0]).toMatchObject({
      memoryRequestMiB: null,
      memoryLimitMiB: null,
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
    expect(
      within(dialog).getByLabelText("Name").getAttribute("placeholder"),
    ).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(within(dialog).getByLabelText("CPU request")).toHaveAttribute(
      "placeholder",
      "4",
    );
    expect(within(dialog).getByLabelText("CPU limit")).toHaveAttribute(
      "placeholder",
      "No limit",
    );
    expect(
      within(dialog).getByLabelText("Memory request (GiB)"),
    ).toHaveAttribute("placeholder", "8");
    expect(within(dialog).getByLabelText("Memory limit (GiB)")).toHaveAttribute(
      "placeholder",
      "16",
    );
    expect(
      within(dialog).getByLabelText("Memory request (GiB)"),
    ).toHaveAccessibleDescription("2x CPU by default");
    expect(
      within(dialog).getByLabelText("Memory limit (GiB)"),
    ).toHaveAccessibleDescription(
      "2x memory request by default The default limit in GiB is max(2x memory request, 2x CPU request, 2x CPU limit).",
    );
    const memoryHint = within(dialog).getByRole("button", {
      name: "2x memory request by default",
    });
    await user.hover(memoryHint);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "The default limit in GiB is max(2x memory request, 2x CPU request, 2x CPU limit).",
    );
    await user.hover(within(dialog).getByLabelText("Disk (GiB)"));
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByLabelText("Memory limit (GiB)"));
    await user.tab();
    expect(memoryHint).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "The default limit in GiB is max(2x memory request, 2x CPU request, 2x CPU limit).",
    );
    // The disk field shows the deployment's default.
    expect(within(dialog).getByLabelText("Disk (GiB)")).toHaveAttribute(
      "placeholder",
      "20",
    );
    expect(within(dialog).getByTestId("tier-workspace")).toHaveTextContent(
      "20 GiB by default",
    );
    expect(
      within(dialog).getByRole("switch", { name: "Pooled" }),
    ).toBeChecked();
    await user.hover(
      within(dialog).getByRole("button", { name: "About pooled tiers" }),
    );
    const hint = await screen.findByRole("dialog", {
      name: "About pooled tiers",
    });
    expect(hint).toHaveTextContent(
      "Agent runs start much quicker from pool of runtime instances. Managed automatically. Pooled instances reserve part of cluster's capacity. Learn more",
    );
    expect(
      within(hint).getByRole("link", { name: /Learn more/ }),
    ).toHaveAttribute(
      "href",
      expect.stringMatching(/\/docs\/agents\/runtime\/setup#warm-pools$/),
    );
  });

  it("calculates both defaults from CPU and lets each memory field override its default", async () => {
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
    await user.type(within(dialog).getByLabelText("Name"), "Memory");
    await user.type(within(dialog).getByLabelText("CPU request"), "4");
    const request = within(dialog).getByLabelText("Memory request (GiB)");
    const limit = within(dialog).getByLabelText("Memory limit (GiB)");
    expect(request).toHaveAttribute("placeholder", "8");
    expect(limit).toHaveAttribute("placeholder", "16");
    await user.type(within(dialog).getByLabelText("CPU limit"), "10");
    expect(limit).toHaveAttribute("placeholder", "20");
    await user.type(request, "6");
    await user.type(limit, "30");
    await user.click(
      within(dialog).getByRole("button", { name: "Create tier" }),
    );
    expect(onSave.mock.calls[0][0].tiers.at(-1)).toMatchObject({
      cpuRequest: 4,
      cpuLimit: 10,
      memoryRequestMiB: 6144,
      memoryLimitMiB: 30720,
    });
    await user.clear(request);
    await user.clear(limit);
    await user.click(
      within(dialog).getByRole("button", { name: "Create tier" }),
    );
    expect(onSave.mock.calls[1][0].tiers.at(-1)).toMatchObject({
      memoryRequestMiB: null,
      memoryLimitMiB: null,
    });
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

  it("updates the default limit from memory and CPU changes while an explicit limit wins", async () => {
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
    await user.type(within(dialog).getByLabelText("Name"), "Memory");
    await user.type(within(dialog).getByLabelText("CPU request"), "4");
    const memoryRequest = within(dialog).getByLabelText("Memory request (GiB)");
    const memoryLimit = within(dialog).getByLabelText("Memory limit (GiB)");
    expect(memoryLimit).toHaveAttribute("placeholder", "16");
    await user.type(memoryRequest, "12");
    expect(memoryLimit).toHaveAttribute("placeholder", "24");
    await user.type(within(dialog).getByLabelText("CPU limit"), "16");
    expect(memoryLimit).toHaveAttribute("placeholder", "32");
    await user.type(memoryLimit, "12");
    await user.click(
      within(dialog).getByRole("button", { name: "Create tier" }),
    );
    expect(onSave.mock.calls[0][0].tiers.at(-1)).toMatchObject({
      memoryRequestMiB: 12288,
      memoryLimitMiB: 12288,
    });
    await user.clear(memoryLimit);
    expect(memoryLimit).toHaveAttribute("placeholder", "32");
    await user.click(
      within(dialog).getByRole("button", { name: "Create tier" }),
    );
    expect(onSave.mock.calls[1][0].tiers.at(-1)).toMatchObject({
      memoryRequestMiB: 12288,
      memoryLimitMiB: null,
    });
  });
});
