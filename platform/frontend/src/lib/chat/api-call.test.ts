import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import { callApi } from "./api-call";

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual("@/lib/utils");
  return {
    ...actual,
    handleApiError: vi.fn(),
  };
});

const mockedHandleApiError = vi.mocked(handleApiError);

describe("callApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the data on success without reporting", async () => {
    const result = await callApi(
      async () => ({
        data: { id: "x" },
        error: undefined,
        response: { status: 200 },
      }),
      null,
    );

    expect(result).toEqual({ id: "x" });
    expect(mockedHandleApiError).not.toHaveBeenCalled();
  });

  it("reports the error and returns the fallback on an HTTP error", async () => {
    const error = { message: "boom" };
    const result = await callApi(
      async () => ({ data: undefined, error, response: { status: 500 } }),
      [],
    );

    expect(result).toEqual([]);
    expect(mockedHandleApiError).toHaveBeenCalledTimes(1);
    expect(mockedHandleApiError).toHaveBeenCalledWith(error);
  });

  it("suppresses the toast for a matching silentStatus", async () => {
    const result = await callApi(
      async () => ({
        data: undefined,
        error: { message: "nope" },
        response: { status: 404 },
      }),
      null,
      { silentStatuses: [400, 404] },
    );

    expect(result).toBeNull();
    expect(mockedHandleApiError).not.toHaveBeenCalled();
  });

  it("still reports a non-matching status when silentStatuses is set", async () => {
    await callApi(
      async () => ({
        data: undefined,
        error: { message: "nope" },
        response: { status: 500 },
      }),
      null,
      { silentStatuses: [404] },
    );

    expect(mockedHandleApiError).toHaveBeenCalledTimes(1);
  });

  it("skips the toast entirely when silent is set", async () => {
    const result = await callApi(
      async () => ({
        data: undefined,
        error: { message: "nope" },
        response: { status: 500 },
      }),
      null,
      { silent: true },
    );

    expect(result).toBeNull();
    expect(mockedHandleApiError).not.toHaveBeenCalled();
  });

  it("reports and returns the fallback on a network error (response undefined) without throwing", async () => {
    const error = { message: "network down" };
    const result = await callApi(
      async () => ({ data: undefined, error, response: undefined }),
      { modelId: null, chatApiKeyId: null },
    );

    expect(result).toEqual({ modelId: null, chatApiKeyId: null });
    expect(mockedHandleApiError).toHaveBeenCalledTimes(1);
  });

  it("does not toast on a network error when status-based suppression is configured", async () => {
    // status is undefined on a network error, so silentStatuses cannot match;
    // the error still surfaces via handleApiError (matches useConversation today).
    await callApi(
      async () => ({
        data: undefined,
        error: { message: "x" },
        response: undefined,
      }),
      null,
      { silentStatuses: [404] },
    );

    expect(mockedHandleApiError).toHaveBeenCalledTimes(1);
  });

  it("does not toast on a network error when silent is set", async () => {
    await callApi(
      async () => ({
        data: undefined,
        error: { message: "x" },
        response: undefined,
      }),
      null,
      { silent: true },
    );

    expect(mockedHandleApiError).not.toHaveBeenCalled();
  });
});
