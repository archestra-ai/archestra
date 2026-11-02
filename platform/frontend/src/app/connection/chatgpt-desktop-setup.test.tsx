import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { ChatgptDesktopSetup } from "./chatgpt-desktop-setup";
import type { ConnectPageData } from "./connect-page-data";

function Harness({
  installerCommand,
  includeTools = true,
  includeSkills = true,
}: {
  installerCommand: ConnectPageData["installerCommand"];
  includeTools?: boolean;
  includeSkills?: boolean;
}) {
  const [windows, setWindows] = useState(false);
  const data = {
    appName: "Example Platform",
    windows,
    setWindows,
    installerCommand,
  } as unknown as ConnectPageData;
  return (
    <ChatgptDesktopSetup
      data={data}
      includeTools={includeTools}
      includeSkills={includeSkills}
    />
  );
}

it("shows the Codex setup command, which also routes the desktop app", () => {
  const installerCommand = vi.fn(
    (client, _choices, windows: boolean) =>
      `${windows ? "irm" : "curl"} --client ${client.id}`,
  ) as unknown as ConnectPageData["installerCommand"];
  render(<Harness installerCommand={installerCommand} />);

  expect(screen.getByText("curl --client codex")).toBeVisible();
  expect(installerCommand).toHaveBeenCalledWith(
    expect.objectContaining({ id: "codex" }),
    { tools: true, skills: true, proxy: true, plugins: false },
    false,
    { gatewayId: null, pluginIds: null },
  );
  expect(
    screen.getByText(/Guardrails check each tool call/, { exact: false }),
  ).toBeVisible();
  expect(
    screen.getByText(/the approval page shows Codex/, { exact: false }),
  ).toBeVisible();
});

it("switches to the Windows command and keeps left-out parts out", async () => {
  const installerCommand = vi.fn(
    (client, _choices, windows: boolean) =>
      `${windows ? "irm" : "curl"} --client ${client.id}`,
  ) as unknown as ConnectPageData["installerCommand"];
  render(
    <Harness
      installerCommand={installerCommand}
      includeTools={false}
      includeSkills={false}
    />,
  );

  await userEvent.click(
    screen.getByRole("button", { name: /Use the Windows command/ }),
  );

  expect(screen.getByText("irm --client codex")).toBeVisible();
  expect(installerCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "codex" }),
    { tools: false, skills: false, proxy: true, plugins: false },
    true,
    { gatewayId: null, pluginIds: null },
  );
});
