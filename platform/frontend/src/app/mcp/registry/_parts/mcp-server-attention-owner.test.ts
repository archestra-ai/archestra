import { describe, expect, it } from "vitest";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import {
  describeMcpIssueActionOwner,
  describeMcpIssueActionOwners,
} from "./mcp-server-attention-owner";
import type { InstalledServer } from "./mcp-server-card";

const issue = (catalogId: string, serverId: string): McpServerIssue => ({
  kind: "needs-reauth",
  audience: "others",
  catalogId,
  serverId,
  detail: null,
  since: null,
  fingerprint: `v1:needs-reauth:${serverId}`,
  muted: false,
  mutedReason: null,
});

const server = ({
  id,
  catalogId,
  ownerEmail,
}: {
  id: string;
  catalogId: string;
  ownerEmail: string | null;
}) => ({ id, catalogId, ownerEmail }) as InstalledServer;

describe("MCP attention action ownership", () => {
  it("uses visible identity on the row and a role fallback otherwise", () => {
    const reauth = issue("cat-1", "srv-1");
    expect(
      describeMcpIssueActionOwner({
        issue: reauth,
        servers: [
          server({
            id: "srv-1",
            catalogId: "cat-1",
            ownerEmail: "owner@example.com",
          }),
        ],
      }).fact,
    ).toBe("Owner: owner@example.com");
    expect(
      describeMcpIssueActionOwner({
        issue: reauth,
        servers: [
          server({ id: "srv-1", catalogId: "cat-1", ownerEmail: null }),
        ],
      }).fact,
    ).toBe("Owner: other user");
  });

  it("does not attribute a grouped row to one of several actors", () => {
    expect(
      describeMcpIssueActionOwners({
        issues: [issue("cat-1", "srv-1"), issue("cat-1", "srv-2")],
        servers: [
          server({
            id: "srv-1",
            catalogId: "cat-1",
            ownerEmail: "first@example.com",
          }),
          server({
            id: "srv-2",
            catalogId: "cat-1",
            ownerEmail: "second@example.com",
          }),
        ],
      }),
    ).toMatchObject({
      label: "Multiple actors",
      sentence: "Multiple people or roles need to act.",
    });
  });
});
