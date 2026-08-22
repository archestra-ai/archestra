import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { type PluginPlatform, PluginPlatforms } from "./plugin-platforms";

function Harness() {
  const [value, setValue] = useState<PluginPlatform[]>(["posix"]);
  return (
    <>
      <PluginPlatforms value={value} onChange={setValue} />
      <output data-testid="platforms">{value.join(",")}</output>
    </>
  );
}

describe("PluginPlatforms", () => {
  test("marks a reviewed plugin as Windows-only", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: /Windows/ }));
    await user.click(screen.getByRole("checkbox", { name: /macOS \/ Linux/ }));

    expect(screen.getByTestId("platforms")).toHaveTextContent("windows");
  });

  test("never allows an empty compatibility declaration", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: /macOS \/ Linux/ }));

    expect(screen.getByTestId("platforms")).toHaveTextContent("posix");
  });
});
