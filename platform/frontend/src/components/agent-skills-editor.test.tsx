import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AgentSkillsEditor, type EditableSkill } from "./agent-skills-editor";

// The dropdown positions itself with floating-ui, which constructs a
// ResizeObserver; jsdom has none, so it needs a real constructible stub.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const gateway = {};
const currentUserId = "admin-1";

const skills: EditableSkill[] = [
  { id: "s1", name: "ordinary-skill", scope: "org" },
  { id: "s2", name: "templated-skill", scope: "org", templated: true },
  { id: "s3", name: "delegated-skill", scope: "org", agentName: "helper" },
  { id: "s4", name: "personal-skill", scope: "personal", authorId: "user-9" },
  {
    id: "s5",
    name: "own-personal-skill",
    scope: "personal",
    authorId: currentUserId,
  },
];

function Harness({
  tone = "assign",
  initial = [],
  availableSkills = skills,
}: {
  tone?: "assign" | "exclude";
  initial?: string[];
  availableSkills?: EditableSkill[];
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  return (
    <AgentSkillsEditor
      availableSkills={availableSkills}
      selectedSkillIds={selected}
      onSelectionChange={setSelected}
      gateway={gateway}
      currentUserId={currentUserId}
      tone={tone}
    />
  );
}

describe("AgentSkillsEditor", () => {
  it("offers a publishable skill and selects it", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /add/i }));
    await user.click(await screen.findByText("ordinary-skill"));

    expect(
      screen.getByRole("button", { name: "Remove ordinary-skill" }),
    ).toBeInTheDocument();
  });

  it("disables skills that cannot be published and says why", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(await screen.findByText(/rendered per user/i)).toBeInTheDocument();
    expect(screen.getByText(/no equivalent over MCP/i)).toBeInTheDocument();
    expect(
      screen.getByText(/only its author can publish it/i),
    ).toBeInTheDocument();
  });

  it("offers the caller's own personal skill with the audience disclosure", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /add/i }));
    // Publishable — but flagged: publication serves it to every token holder.
    expect(
      await screen.findByText(/everyone holding this gateway's token/i),
    ).toBeInTheDocument();
    await user.click(screen.getByText("own-personal-skill"));

    expect(
      screen.getByRole("button", { name: "Remove own-personal-skill" }),
    ).toBeInTheDocument();
  });

  it("keeps every skill selectable when excluding, since excluding only narrows", async () => {
    const user = userEvent.setup();
    render(<Harness tone="exclude" />);

    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(screen.queryByText(/rendered per user/i)).not.toBeInTheDocument();
    await user.click(await screen.findByText("templated-skill"));
    expect(
      screen.getByRole("button", { name: "Remove templated-skill" }),
    ).toBeInTheDocument();
  });

  it("lets an already-assigned skill be removed even once it is unpublishable", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["s2"]} />);

    const remove = screen.getByRole("button", {
      name: "Remove templated-skill",
    });
    await user.click(remove);

    expect(
      screen.queryByRole("button", { name: "Remove templated-skill" }),
    ).not.toBeInTheDocument();
  });

  it("shows a chip only for a selected skill it was handed a row for", async () => {
    // The contract callers have to work around: chips are drawn from
    // `availableSkills`, so a selected id whose row is no longer in that list
    // renders nothing at all while staying selected and submitted. AgentDialog
    // composes the list from a catalog page plus the current search hits, both
    // of which drop a skill picked from an earlier query — hence the picked-row
    // memory there. Shrinking the list is the only way to reach this branch.
    const { rerender } = render(
      <Harness initial={["s1"]} availableSkills={skills} />,
    );

    expect(
      screen.getByRole("button", { name: "Remove ordinary-skill" }),
    ).toBeInTheDocument();

    rerender(
      <Harness
        initial={["s1"]}
        availableSkills={skills.filter((skill) => skill.id !== "s1")}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Remove ordinary-skill" }),
    ).not.toBeInTheDocument();
  });
});
