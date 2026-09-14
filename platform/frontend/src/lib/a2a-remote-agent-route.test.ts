import { describe, expect, it } from "vitest";
import {
  a2aRemoteAgentDetailHref,
  a2aRemoteAgentNewHref,
} from "./a2a-remote-agent-route";

describe("external A2A agent routes", () => {
  it("keeps creation and details inside the Agents route family", () => {
    expect(a2aRemoteAgentNewHref()).toBe("/agents/a2a/new");
    expect(a2aRemoteAgentDetailHref("remote agent/1")).toBe(
      "/agents/a2a/remote%20agent%2F1",
    );
  });
});
