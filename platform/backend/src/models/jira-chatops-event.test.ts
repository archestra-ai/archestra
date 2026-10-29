import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  enqueueJiraChatOpsEvent,
  handleJiraChatOpsEvent,
} from "@/services/jira-chatops-events";
import { describe, expect, test } from "@/test";
import JiraChatOpsEventModel from "./jira-chatops-event";

describe("durable Jira receipts", () => {
  test("dedupes equivalent revision timestamps across deliveries, atomically queues once, stores no content or auth", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const params = {
      integrationId: randomUUID(),
      botId: randomUUID(),
      organizationId: organization.id,
      payload: {
        webhookEvent: "comment_created",
        issue: { id: "10000", description: "private content" },
        comment: {
          id: "20000",
          updated: "2026-10-26T10:00:00.000+0000",
          body: "private content",
        },
      },
      headers: {
        "x-archestra-jira-secret": "synthetic-secret",
        "x-atlassian-webhook-identifier": "delivery-one",
      },
    };
    const first = await enqueueJiraChatOpsEvent(params);
    const second = await enqueueJiraChatOpsEvent({
      ...params,
      eventId: "delivery-two",
      payload: {
        ...params.payload,
        comment: {
          ...params.payload.comment,
          updated: "2026-10-26T06:00:00.0-0400",
        },
      },
    });
    expect(first?.created).toBe(true);
    expect(second).toEqual({ id: first?.id, created: false });
    const receipt = await JiraChatOpsEventModel.findById(first?.id ?? "");
    expect(receipt?.payload).toEqual({
      webhookEvent: "comment_created",
      issue: { id: "10000" },
      comment: { id: "20000", updated: "2026-10-26T10:00:00.000+0000" },
    });
    expect(JSON.stringify(receipt)).not.toContain("synthetic-secret");
    const jobs = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "jira_chatops_event"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ receiptId: first?.id });
    const edited = await enqueueJiraChatOpsEvent({
      ...params,
      payload: {
        ...params.payload,
        comment: {
          ...params.payload.comment,
          updated: "2026-10-26T10:01:00.000+0000",
        },
      },
    });
    expect(edited?.created).toBe(true);
  });

  test("fences claims and holds an interrupted dispatch without launching again", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const receipt = await JiraChatOpsEventModel.enqueue({
      integrationId: randomUUID(),
      botId: randomUUID(),
      organizationId: organization.id,
      eventKey: "revision",
      payload: {},
    });
    const first = await JiraChatOpsEventModel.claim(receipt.id);
    expect(first?.claimId).toBeTruthy();
    expect(await JiraChatOpsEventModel.claim(receipt.id)).toBeNull();
    const claim = { id: receipt.id, claimId: first?.claimId ?? "" };
    await JiraChatOpsEventModel.markDispatched(claim);
    await JiraChatOpsEventModel.release(claim);
    await handleJiraChatOpsEvent({ receiptId: receipt.id });
    expect((await JiraChatOpsEventModel.findById(receipt.id))?.state).toBe(
      "held",
    );
    await expect(JiraChatOpsEventModel.complete(claim)).rejects.toThrow(
      "lease lost",
    );
  });
});
