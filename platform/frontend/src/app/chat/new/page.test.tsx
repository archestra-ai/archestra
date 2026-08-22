import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () =>
    new URLSearchParams({
      mcp_skill_id: "11111111-1111-4111-8111-111111111111",
      mcp_server_id: "33333333-3333-4333-8333-333333333333",
      mcp_skill_uri: "skill://example/release/SKILL.md",
      mcp_skill_name: "release-checklist",
      mcp_server_name: "Operations server",
      mcp_skill_display_name:
        "Operations server [team:33333333] / release-checklist",
    }),
}));

import ChatNewPage from "./page";

describe("ChatNewPage", () => {
  it("forwards an external MCP Skill into the chat composer deep link", async () => {
    render(<ChatNewPage />);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "/chat?externalMcpSkillId=11111111-1111-4111-8111-111111111111&externalMcpServerId=33333333-3333-4333-8333-333333333333&externalMcpSkillUri=skill%3A%2F%2Fexample%2Frelease%2FSKILL.md&externalMcpSkillName=release-checklist&externalMcpServerName=Operations+server&externalMcpSkillDisplayName=Operations+server+%5Bteam%3A33333333%5D+%2F+release-checklist",
      ),
    );
  });
});
