import { archestraApiClient } from "@archestra/shared";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useBackendConnectivity } from "./backend-connectivity";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer(
  http.get(`${API_ORIGIN}/ready`, () =>
    HttpResponse.json(
      {
        name: "archestra",
        status: "degraded",
        version: "1",
        database: "disconnected",
      },
      { status: 503 },
    ),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("sign-in readiness", () => {
  it("recognizes a reachable backend with a disconnected database", async () => {
    const { result } = renderHook(() => useBackendConnectivity());

    await waitFor(() =>
      expect(result.current.status).toBe("database-connecting"),
    );
  });
});
