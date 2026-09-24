import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  type CoverageTool,
  useAllCoverageToolsForCatalogs,
} from "@/lib/openappa-coverage.query";
import { type PickedTool, RuleFlow } from "./setup-rule-flow";

vi.mock("@/lib/openappa-coverage.query", async (importOriginal) => ({
  ...(await importOriginal()),
  useAllCoverageToolsForCatalogs: vi.fn(),
}));

const github = "e8340e76-19fc-444d-ac4e-a817c1e78c3c";

function coverageTool(
  name: string,
  readOnly: boolean | null,
  catalogId = github,
): CoverageTool {
  return {
    toolId: crypto.randomUUID(),
    catalogId,
    catalogName: catalogId === github ? "GitHub" : "Built in",
    name,
    fullName: `${catalogId === github ? "github" : "archestra"}__${name}`,
    readOnly,
    rule: null,
  } as CoverageTool;
}

beforeEach(() => {
  vi.mocked(useAllCoverageToolsForCatalogs).mockReturnValue({
    tools: [
      coverageTool("get_issue", true),
      coverageTool("get_legacy", false),
      coverageTool("delete_issue", false),
      coverageTool("save_file", false, ARCHESTRA_MCP_CATALOG_ID),
    ],
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  } as ReturnType<typeof useAllCoverageToolsForCatalogs>);
});

test.each([
  { isPending: true, message: "Loading tools…" },
  { isPending: false, message: "No tool that reads matches." },
])("keeps a picked tool readable when $message", async ({
  isPending,
  message,
}) => {
  const user = userEvent.setup();
  vi.mocked(useAllCoverageToolsForCatalogs).mockReturnValue({
    tools: [],
    isPending,
    isError: false,
    refetch: vi.fn(),
  } as ReturnType<typeof useAllCoverageToolsForCatalogs>);
  render(
    <RuleFlow
      shape="flow"
      source={{
        toolId: "source-id",
        fullName: "github__get_issue",
        name: "get_issue",
        server: "GitHub",
        catalogId: github,
        rule: null,
      }}
      guarded={null}
      edit={{
        catalogs: [{ id: github, name: "GitHub" }],
        onSource: vi.fn(),
        onGuarded: vi.fn(),
      }}
    />,
  );

  const picker = screen.getByRole("combobox", {
    name: "Tool that reads: get_issue. Change",
  });
  expect(picker).toHaveTextContent("GitHub");
  expect(picker).toHaveTextContent("get_issue");
  expect(picker).not.toHaveTextContent("github__get_issue");
  await user.click(picker);
  expect(screen.getByText(message)).toBeInTheDocument();
});

test("shared picker honors read hints, suggestions, and the excluded counterpart", async () => {
  const user = userEvent.setup();
  function Editor() {
    const [source, setSource] = useState<PickedTool | null>(null);
    const [guarded, setGuarded] = useState<PickedTool | null>(null);
    return (
      <RuleFlow
        shape="flow"
        source={source}
        guarded={guarded}
        edit={{
          catalogs: [
            { id: github, name: "GitHub" },
            { id: ARCHESTRA_MCP_CATALOG_ID, name: "Built in" },
          ],
          onSource: setSource,
          onGuarded: setGuarded,
        }}
      />
    );
  }
  render(<Editor />);

  await user.click(
    screen.getByRole("combobox", { name: "Tool that reads: pick a tool" }),
  );
  expect(screen.getByRole("option", { name: /get_issue/ })).toBeEnabled();
  expect(screen.queryByRole("option", { name: /get_legacy/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /delete_issue/ })).toBeNull();
  await user.click(screen.getByRole("option", { name: /get_issue/ }));

  await user.click(
    screen.getByRole("combobox", {
      name: "Tool that needs approval: pick a tool",
    }),
  );
  expect(screen.getByRole("option", { name: /save_file/ })).toHaveTextContent(
    "Suggested",
  );
  expect(screen.getByRole("option", { name: /get_legacy/ })).toBeEnabled();
  await user.click(
    screen.getByRole("button", { name: "Also list tools that only read" }),
  );
  expect(screen.getByRole("option", { name: /get_issue/ })).toBeDisabled();
  await user.click(screen.getByRole("option", { name: /delete_issue/ }));
  expect(
    screen.getByRole("combobox", {
      name: "Tool that needs approval: delete_issue. Change",
    }),
  ).toBeInTheDocument();

  await user.click(
    screen.getByRole("combobox", {
      name: "Tool that needs approval: delete_issue. Change",
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Also list tools that only read" }),
  );
  await user.type(screen.getByPlaceholderText("Search tools…"), "get_issue");
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("combobox", {
      name: "Tool that needs approval: delete_issue. Change",
    }),
  );
  expect(screen.getByPlaceholderText("Search tools that act…")).toHaveValue("");
  expect(screen.getByRole("option", { name: /delete_issue/ })).toBeEnabled();
});
