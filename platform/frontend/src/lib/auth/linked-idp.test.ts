import { LINKED_IDP_OTHER_SESSION_ERROR_CODE } from "@archestra/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  completeLinkedIdentityProviderIntent,
  LinkedIdentityProviderOtherSessionError,
} from "./linked-idp";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("completeLinkedIdentityProviderIntent", () => {
  test("reports a link finished in another browser session with the server's message", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          code: LINKED_IDP_OTHER_SESSION_ERROR_CODE,
          message: "Finish in the same browser session.",
        },
        { status: 400 },
      ),
    );

    const error = await completeLinkedIdentityProviderIntent("intent-1").catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(LinkedIdentityProviderOtherSessionError);
    expect((error as Error).message).toBe(
      "Finish in the same browser session.",
    );
  });

  test("keeps other failures generic", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { message: "Linked identity provider request expired" },
        { status: 400 },
      ),
    );

    const error = await completeLinkedIdentityProviderIntent("intent-1").catch(
      (e: unknown) => e,
    );

    expect(error).not.toBeInstanceOf(LinkedIdentityProviderOtherSessionError);
    expect((error as Error).message).toBe(
      "Failed to complete identity provider link request",
    );
  });
});
