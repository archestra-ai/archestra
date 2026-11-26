import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import { afterEach, describe, expect, test } from "@/test";
import {
  fakeWorkspacePod as fakePod,
  seedRetainedRun as seededRun,
} from "@/test/agent-runtime-workspace";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  RELAYED_UPLOAD_TICKET_TTL_MS,
  WORKSPACE_TRANSFER_TICKET_TTL_MS,
  workspaceTransferTickets,
} from "./workspace-transfers";

setupTestCacheManager();

/**
 * The tool call that mints a ticket and the curl command that redeems it hit
 * whichever replica the load balancer picks, and the only thing replicas
 * share is the database. A ticket that is not in the shared cache is a
 * ticket another replica cannot honour.
 */
describe("transfer tickets in the shared cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("an upload ticket is written to the shared cache and gone from it once redeemed", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    });
    const pod = fakePod(Buffer.alloc(0));
    const bytes = Buffer.from("workspace-transfer-probe\n");
    const sha256 = digest(bytes);
    const minted = await workspaceTransferTickets.mintUpload({
      ...seeded,
      path: "probe/incoming/hello.txt",
      size: bytes.length,
      sha256,
    });

    expect(await cachedTicket(minted.ticket.id)).toMatchObject({
      direction: "upload",
      path: "probe/incoming/hello.txt",
      sha256,
    });

    const ticket = await workspaceTransferTickets.resolve(
      minted.ticket.id,
      minted.token,
    );
    const received = await workspaceTransferTickets.receive({
      ticket,
      body: Readable.from([bytes]),
    });

    expect(received).toMatchObject({
      path: "probe/incoming/hello.txt",
      size: bytes.length,
      sha256,
    });
    expect(pod.staged.get(ticket.entryId)?.equals(bytes)).toBe(true);
    expect(pod.finalized).toEqual([
      [ticket.entryId, "probe/incoming/hello.txt", sha256, "-", "0"],
    ]);
    // A redeemed ticket is gone for every replica.
    expect(await cachedTicket(minted.ticket.id)).toBeUndefined();
    await expect(
      workspaceTransferTickets.resolve(minted.ticket.id, minted.token),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("a download ticket stays in the shared cache for resumes, and a wrong token, an unknown id or an expired ticket is not found", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    });
    const file = Buffer.from("report: step 1 done\n");
    fakePod(file);
    const minted = await workspaceTransferTickets.mintDownload({
      ...seeded,
      path: "reports/summary.md",
    });

    const ticket = await workspaceTransferTickets.resolve(
      minted.ticket.id,
      minted.token,
    );
    expect(ticket).toMatchObject({
      direction: "download",
      size: file.length,
      sha256: digest(file),
    });
    const resumed = await workspaceTransferTickets.read({
      ticket,
      offset: 8,
      length: -1,
    });
    const parts: Buffer[] = [];
    for await (const part of resumed.stdout) parts.push(Buffer.from(part));
    await resumed.completed;
    expect(Buffer.concat(parts).equals(file.subarray(8))).toBe(true);
    // Still there: the next Range request may come from any replica.
    expect(await cachedTicket(minted.ticket.id)).toMatchObject({
      direction: "download",
    });

    await expect(
      workspaceTransferTickets.resolve(
        minted.ticket.id,
        `${minted.token.slice(1)}x`,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      workspaceTransferTickets.resolve("not-a-ticket", minted.token),
    ).rejects.toMatchObject({ statusCode: 404 });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + WORKSPACE_TRANSFER_TICKET_TTL_MS + 1000);
    await expect(
      workspaceTransferTickets.resolve(minted.ticket.id, minted.token),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

/**
 * A relayed ticket is what the MCP gateway redeems for an upload it takes
 * from its own caller: no token is ever handed out, so the gateway's
 * caller-bound upload target is the only way in.
 */
describe("relayed upload tickets", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("without a declared digest, the bytes are checked against the digest computed while they streamed", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    });
    const pod = fakePod();
    const bytes = Buffer.from("relayed upload\n");
    const minted = await workspaceTransferTickets.mintRelayedUpload({
      ...seeded,
      path: "inbox/relayed.txt",
      size: bytes.length,
      ttlMs: RELAYED_UPLOAD_TICKET_TTL_MS,
    });
    expect(minted.expiresAt).toBeGreaterThan(
      Date.now() + WORKSPACE_TRANSFER_TICKET_TTL_MS,
    );
    expect(await cachedTicket(minted.ticketId)).not.toHaveProperty("sha256");

    const ticket = await workspaceTransferTickets.resolveRelayed(
      minted.ticketId,
    );
    const received = await workspaceTransferTickets.receive({
      ticket,
      body: Readable.from([bytes]),
      sha256: () => digest(bytes),
    });
    expect(received).toMatchObject({
      path: "inbox/relayed.txt",
      size: bytes.length,
      sha256: digest(bytes),
    });
    expect(pod.finalized).toEqual([
      [ticket.entryId, "inbox/relayed.txt", digest(bytes), "-", "0"],
    ]);
    await expect(
      workspaceTransferTickets.resolveRelayed(minted.ticketId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("bytes that differ from the computed digest, or from the declared size, never finalize", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    });
    const pod = fakePod();
    const bytes = Buffer.from("relayed upload\n");
    for (const [body, sha256] of [
      [bytes, digest(Buffer.from("something else"))],
      [bytes.subarray(1), digest(bytes.subarray(1))],
    ] as const) {
      const minted = await workspaceTransferTickets.mintRelayedUpload({
        ...seeded,
        path: "inbox/relayed.txt",
        size: bytes.length,
        ttlMs: RELAYED_UPLOAD_TICKET_TTL_MS,
      });
      await expect(
        workspaceTransferTickets.receive({
          ticket: await workspaceTransferTickets.resolveRelayed(
            minted.ticketId,
          ),
          body: Readable.from([body]),
          sha256: () => sha256,
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
    }
    expect(pod.finalized).toEqual([]);
  });

  test("a relayed ticket cannot be redeemed with a token, and a token ticket cannot be redeemed as relayed", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const seeded = await seededRun({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    });
    fakePod();
    const bytes = Buffer.from("x");
    const relayed = await workspaceTransferTickets.mintRelayedUpload({
      ...seeded,
      path: "inbox/a.txt",
      size: 1,
      ttlMs: RELAYED_UPLOAD_TICKET_TTL_MS,
    });
    const tokened = await workspaceTransferTickets.mintUpload({
      ...seeded,
      path: "inbox/b.txt",
      size: 1,
      sha256: digest(bytes),
    });
    await expect(
      workspaceTransferTickets.resolve(relayed.ticketId, tokened.token),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      workspaceTransferTickets.resolveRelayed(tokened.ticket.id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// =============================================================================
// Helpers
// =============================================================================

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What any replica would find for this ticket. */
async function cachedTicket(id: string) {
  return cacheManager.get<Record<string, unknown>>(
    `${CacheKey.AgentWorkspaceTransferTicket}-${id}`,
  );
}
