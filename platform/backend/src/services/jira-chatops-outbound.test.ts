import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import JiraChatOpsDeliveryModel from "@/models/jira-chatops-delivery";
import {
  executeJiraChatOpsOutbound,
  JiraOutboundRejectedError,
} from "./jira-chatops-outbound";

describe("Jira outbound intent and reconciliation", () => {
  test("a definitive 429 retries the same intent later and accepts only one POST", async () => {
    const params = options();
    params.send.mockRejectedValueOnce(new JiraOutboundRejectedError(429));
    await expect(executeJiraChatOpsOutbound(params)).rejects.toBeInstanceOf(
      JiraOutboundRejectedError,
    );
    expect(
      (await JiraChatOpsDeliveryModel.findByOperationKey(params))
        ?.postAttempted,
    ).toBe(false);
    expect(await executeJiraChatOpsOutbound(params)).toBe("20000");
    expect(await executeJiraChatOpsOutbound(params)).toBe("20000");
    expect(params.send).toHaveBeenCalledTimes(2);
    expect(params.send.mock.calls[1][0]).toBe(params.send.mock.calls[0][0]);
    expect(params.reconcile).not.toHaveBeenCalled();
  });

  test("recovers a committed POST with a lost response without a second POST", async () => {
    const params = options();
    params.send.mockRejectedValueOnce(new Error("Lost response"));
    params.reconcile.mockResolvedValue("20000");
    await expect(executeJiraChatOpsOutbound(params)).rejects.toThrow();
    expect(await executeJiraChatOpsOutbound(params)).toBe("20000");
    expect(await executeJiraChatOpsOutbound(params)).toBe("20000");
    expect(params.send).toHaveBeenCalledTimes(1);
    expect(params.reconcile).toHaveBeenCalledWith(params.send.mock.calls[0][0]);
  });

  test("an uncertain POST absent from bounded reconciliation stays held", async () => {
    const params = options();
    params.send.mockRejectedValueOnce(new Error("Lost response"));
    await expect(executeJiraChatOpsOutbound(params)).rejects.toThrow();
    await expect(executeJiraChatOpsOutbound(params)).rejects.toThrow(
      "outcome is uncertain",
    );
    expect(params.send).toHaveBeenCalledTimes(1);
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
    send: vi
      .fn<(operationId: string) => Promise<string>>()
      .mockResolvedValue("20000"),
    reconcile: vi
      .fn<(operationId: string) => Promise<string | null>>()
      .mockResolvedValue(null),
  };
}
