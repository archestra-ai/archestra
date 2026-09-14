import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { AppaRuntimeClient } from "./client";

const native = vi.hoisted(() => ({ openappaNative: vi.fn() }));

vi.mock("@/openappa/native", () => native);

describe("AppaRuntimeClient", () => {
  beforeEach(() => {
    native.openappaNative.mockResolvedValue({
      dispatchOpenappaProxyEvent: vi.fn(),
      dispatchOpenappaCheckpoint: vi.fn(),
      openappaProxyCapabilities: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("maps native diagnostics to a stable, secret-free runtime error", async () => {
    const client = new AppaRuntimeClient();
    const prepared = client.prepareEvent({
      eventId: "event-1",
      event: { event: "session_start" },
    });
    const module = await native.openappaNative();
    module.dispatchOpenappaProxyEvent.mockRejectedValue(
      new Error("postgresql://user:secret@localhost/openappa failed"),
    );

    await expect(client.postPreparedEvent(prepared)).rejects.toMatchObject({
      code: "refused",
      message: "OpenAPPA refused the native operation",
    });
  });
});
