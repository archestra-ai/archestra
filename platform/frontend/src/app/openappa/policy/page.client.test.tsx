import { render, screen } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, expect, test, vi } from "vitest";
import { useServerRulesAccess } from "@/lib/openappa-github-sync.query";
import { PolicyPage } from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/openappa-github-sync.query", () => ({
  useServerRulesAccess: vi.fn(),
}));
vi.mock("../_parts/policy-source-editor", () => ({
  PolicySourceEditor: ({ sourceEntry }: { sourceEntry?: string }) => (
    <div>{`Policy source ${sourceEntry ?? "root"}`}</div>
  ),
}));

const replace = vi.fn();

beforeEach(() => {
  replace.mockReset();
  vi.mocked(useRouter).mockReturnValue({ replace } as unknown as ReturnType<
    typeof useRouter
  >);
});

test("a reader of the organization policy gets the policy source, at the file the URL names", () => {
  vi.mocked(useServerRulesAccess).mockReturnValue({ scoped: false, files: [] });
  render(<PolicyPage sourceEntry="batteries/github/appa.toml" />);

  expect(
    screen.getByText("Policy source batteries/github/appa.toml"),
  ).toBeVisible();
  expect(replace).not.toHaveBeenCalled();
});

test("a reader of MCP servers' rules alone is sent to the file workspace, which lists their files", () => {
  vi.mocked(useServerRulesAccess).mockReturnValue({ scoped: true, files: [] });
  render(<PolicyPage />);

  expect(replace).toHaveBeenCalledWith(
    expect.stringMatching(/^\/openappa\/policy\/workspace/),
  );
  expect(screen.queryByText(/Policy source/)).not.toBeInTheDocument();
});
