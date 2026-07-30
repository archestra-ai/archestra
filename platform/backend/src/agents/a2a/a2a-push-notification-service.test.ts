import { vi } from "vitest";
import {
  A2AContextModel,
  A2APushNotificationConfigModel,
  A2ATaskModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { A2AProtocolTaskState } from "./a2a-protocol";
import { a2aPushNotificationService } from "./a2a-push-notification-service";

/**
 * `fetch` is the process boundary here — the outbound HTTP call to a
 * caller-controlled endpoint. Everything below it (config storage, credential
 * decryption, retry policy) is exercised for real.
 */
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeTask() {
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: crypto.randomUUID(),
  });
  return await A2ATaskModel.create({
    contextId: context.id,
    state: A2AProtocolTaskState.Working,
  });
}

const event = (taskId: string, contextId: string) => ({
  statusUpdate: {
    taskId,
    contextId,
    status: { state: A2AProtocolTaskState.Completed },
  },
});

describe("A2A push notification delivery", () => {
  test("posts the event with the caller's credentials and correlation token", async () => {
    const task = await makeTask();
    await A2APushNotificationConfigModel.create({
      taskId: task.id,
      url: "https://hooks.example.com/a2a",
      token: "corr-1",
      authScheme: "Bearer",
      authCredentials: "super-secret",
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await a2aPushNotificationService.deliver({
      taskId: task.id,
      event: event(task.id, task.contextId),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://hooks.example.com/a2a");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/a2a+json");
    // The credential round-trips through encrypted storage.
    expect(init.headers.Authorization).toBe("Bearer super-secret");
    expect(init.headers["X-A2A-Notification-Token"]).toBe("corr-1");
    // A redirect would carry those credentials to an unvalidated host.
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body).statusUpdate.status.state).toBe(
      A2AProtocolTaskState.Completed,
    );
  });

  test("omits the Authorization header when no credentials were configured", async () => {
    const task = await makeTask();
    await A2APushNotificationConfigModel.create({
      taskId: task.id,
      url: "https://hooks.example.com/a2a",
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await a2aPushNotificationService.deliver({
      taskId: task.id,
      event: event(task.id, task.contextId),
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers["X-A2A-Notification-Token"]).toBeUndefined();
  });

  test("fans out to every webhook registered for the task", async () => {
    const task = await makeTask();
    for (const path of ["one", "two", "three"]) {
      await A2APushNotificationConfigModel.create({
        taskId: task.id,
        url: `https://hooks.example.com/${path}`,
      });
    }
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await a2aPushNotificationService.deliver({
      taskId: task.id,
      event: event(task.id, task.contextId),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("retries a server error, then gives up without throwing", async () => {
    const task = await makeTask();
    await A2APushNotificationConfigModel.create({
      taskId: task.id,
      url: "https://hooks.example.com/a2a",
    });
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    // A webhook that stays down must never surface as a task failure — the
    // event log remains the durable record.
    await expect(
      a2aPushNotificationService.deliver({
        taskId: task.id,
        event: event(task.id, task.contextId),
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  test("does not retry a client rejection", async () => {
    const task = await makeTask();
    await A2APushNotificationConfigModel.create({
      taskId: task.id,
      url: "https://hooks.example.com/a2a",
    });
    // 401 means the receiver rejected our credentials; repeating the call
    // just repeats the mistake.
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    await a2aPushNotificationService.deliver({
      taskId: task.id,
      event: event(task.id, task.contextId),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a task with no webhooks makes no outbound call", async () => {
    const task = await makeTask();

    await a2aPushNotificationService.deliver({
      taskId: task.id,
      event: event(task.id, task.contextId),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses at send time to deliver to a host that is no longer allowed", async () => {
    const task = await makeTask();
    // Bypass the create-time guard to simulate a config stored before the
    // policy tightened, or a URL that only now resolves somewhere private.
    await A2APushNotificationConfigModel.create({
      taskId: task.id,
      url: "https://169.254.169.254/latest/meta-data",
    });

    await a2aPushNotificationService.deliver({
      taskId: task.id,
      event: event(task.id, task.contextId),
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
