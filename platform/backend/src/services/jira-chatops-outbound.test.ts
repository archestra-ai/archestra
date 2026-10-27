import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import JiraChatOpsDeliveryModel from "@/models/jira-chatops-delivery";
import { useMswServer } from "@/test/msw";
import {
  executeJiraChatOpsOutbound,
  JiraOutboundRejectedError,
} from "./jira-chatops-outbound";

// biome-ignore lint/correctness/useHookAtTopLevel: test boundary lifecycle helper
const server = useMswServer();
const url = "https://example.atlassian.net/rest/api/3/issue/10000/comment";

describe("Jira outbound intent and reconciliation", () => {
  test("a definitive 429 retries the same intent later and accepts only one POST", async () => {
    const operationIds: string[] = [];
    let accepted = 0;
    let reconciliations = 0;
    server.use(
      http.post(url, async ({ request }) => {
        operationIds.push(
          ((await request.json()) as { operationId: string }).operationId,
        );
        if (operationIds.length === 1)
          return HttpResponse.json({ error: "rate limited" }, { status: 429 });
        accepted++;
        return HttpResponse.json({ id: "20000" });
      }),
    );
    const params = {
      ...options(),
      send: async (operationId: string) => {
        const response = await fetch(url, {
          method: "POST",
          body: JSON.stringify({ operationId }),
        });
        if (response.status === 429) throw new JiraOutboundRejectedError(429);
        return ((await response.json()) as { id: string }).id;
      },
      reconcile: async () => {
        reconciliations++;
        return null;
      },
    };
    await expect(executeJiraChatOpsOutbound(params)).rejects.toBeInstanceOf(
      JiraOutboundRejectedError,
    );
    expect(
      (await JiraChatOpsDeliveryModel.findByOperationKey(params))
        ?.postAttempted,
    ).toBe(false);
    expect(await executeJiraChatOpsOutbound(params)).toBe("20000");
    expect(await executeJiraChatOpsOutbound(params)).toBe("20000");
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(accepted).toBe(1);
    expect(reconciliations).toBe(0);
  });

  test("recovers a committed POST with a lost response without a second POST", async () => {
    let posts = 0;
    let acceptedOperation: string | undefined;
    server.use(
      http.post(url, async ({ request }) => {
        posts++;
        acceptedOperation = ((await request.json()) as { operationId: string })
          .operationId;
        return HttpResponse.error();
      }),
      http.get(url, () =>
        HttpResponse.json({ operationId: acceptedOperation, id: "20000" }),
      ),
    );
    const params = options();
    await expect(executeJiraChatOpsOutbound(params)).rejects.toThrow();
    expect(await executeJiraChatOpsOutbound(params)).toBe("20000");
    expect(await executeJiraChatOpsOutbound(params)).toBe("20000");
    expect(posts).toBe(1);
  });

  test("an uncertain POST absent from bounded reconciliation stays held", async () => {
    let posts = 0;
    server.use(
      http.post(url, () => {
        posts++;
        return HttpResponse.error();
      }),
      http.get(url, () => HttpResponse.json({ id: null })),
    );
    const params = options();
    await expect(executeJiraChatOpsOutbound(params)).rejects.toThrow();
    await expect(executeJiraChatOpsOutbound(params)).rejects.toThrow(
      "outcome is uncertain",
    );
    expect(posts).toBe(1);
  });

  test("stable operation cannot be reused with another body and cannot be claimed twice", async () => {
    const params = {
      integrationId: randomUUID(),
      botId: randomUUID(),
      issueId: "10000",
      operationKey: "reply:revision",
      bodyDigest: "digest",
      method: "create" as const,
    };
    const operation = await JiraChatOpsDeliveryModel.reserve(params);
    expect(
      (await JiraChatOpsDeliveryModel.claim(operation.id))?.claimId,
    ).toBeTruthy();
    expect(await JiraChatOpsDeliveryModel.claim(operation.id)).toBeNull();
    await expect(
      JiraChatOpsDeliveryModel.reserve({ ...params, bodyDigest: "other" }),
    ).rejects.toThrow("identity conflict");
  });
});

function options() {
  return {
    integrationId: randomUUID(),
    botId: randomUUID(),
    issueId: "10000",
    operationKey: "reply:revision",
    body: { text: "Synthetic reply" },
    send: async (operationId: string) => {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ operationId }),
      });
      return ((await response.json()) as { id: string }).id;
    },
    reconcile: async (operationId: string) => {
      const response = await fetch(url);
      const comment = (await response.json()) as {
        id: string | null;
        operationId?: string;
      };
      return comment.operationId === operationId ? comment.id : null;
    },
  };
}
