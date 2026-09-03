import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");

import { useRouter, useSearchParams } from "next/navigation";
import { SkillEditPage } from "./page.client";

const replace = vi.fn();

function renderPage(searchParams = "") {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(searchParams) as ReturnType<typeof useSearchParams>,
  );
  return render(<SkillEditPage id="skill-1" />);
}

/**
 * The wizard this route hosted is gone — the skill's page is its settings —
 * but its URLs are bookmarked and pasted, so they have to keep arriving
 * somewhere useful.
 */
describe("SkillEditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      replace,
    } as unknown as ReturnType<typeof useRouter>);
  });

  it("sends an old edit link to the skill's own page", () => {
    renderPage();
    expect(replace).toHaveBeenCalledWith("/skills/skill-1");
  });

  it("drops a wizard step, which names a half the form no longer has", () => {
    renderPage("step=access");
    expect(replace).toHaveBeenCalledWith("/skills/skill-1");
  });

  it("carries the rest of the query across", () => {
    renderPage("step=content&openFile=notes.md");
    expect(replace).toHaveBeenCalledWith("/skills/skill-1?openFile=notes.md");
  });
});
