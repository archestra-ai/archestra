import {
  clientForExternalAgentIds,
  OPENCODE_FAMILY_CLIENT_IDS,
} from "@archestra/shared";
import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientIcon as ConnectTileIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import { ClientIcon } from "./provider-icon";

describe("ClientIcon", () => {
  it.each(
    OPENCODE_FAMILY_CLIENT_IDS,
  )("draws the %s client in the logs as its Connect tile does", (id) => {
    const family = clientForExternalAgentIds([id]);
    const tile = CONNECT_CLIENTS.find((client) => client.id === id);
    if (!family || !tile) throw new Error(`${id} is not a known client`);

    const logs = render(<ClientIcon client={family} size={16} />);
    const connect = render(<ConnectTileIcon client={tile} size={36} />);
    const logo = within(logs.container).getByRole("img", {
      name: `${family.label} logo`,
    });
    const tileLogo = within(connect.container).getByRole("img", {
      name: `${tile.label} logo`,
    });

    expect(logo.innerHTML).toBe(tileLogo.innerHTML);
    expect(logo.getAttribute("viewBox")).toBe(tileLogo.getAttribute("viewBox"));
    expect(logo.parentElement?.style.background).toBe(
      tileLogo.parentElement?.style.background,
    );
    // The brand tile keeps its colours in dark mode, like the Connect page.
    expect(logo.parentElement?.className).not.toContain("invert");
  });
});
