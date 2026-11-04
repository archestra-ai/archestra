import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { makeVirtualKey } from "@/mocks/data/llm-keys";
import { RotateVirtualKeyDialog } from "./virtual-key-rotation";

vi.mock("sonner");

// Radix Select needs pointer capture and scrollIntoView, which jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const API_ORIGIN = "http://localhost:9000";
const KEY_ID = "8f6c2c1e-1d2b-4c3a-9e8f-7a6b5c4d3e2f";

let rotateBodies: unknown[] = [];
let rotateResponse: Record<string, unknown> = {};

const server = setupServer(
  http.post(
    `${API_ORIGIN}/api/llm-virtual-keys/${KEY_ID}/rotate`,
    async ({ request }) => {
      rotateBodies.push(await request.json());
      return HttpResponse.json(rotateResponse);
    },
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => {
  server.resetHandlers();
  rotateBodies = [];
});
afterAll(() => server.close());

describe("RotateVirtualKeyDialog", () => {
  it("rotates with the chosen grace period and shows the new value once", async () => {
    rotateResponse = {
      ...makeVirtualKey({ id: KEY_ID }),
      value: "archestra_new_value",
      previousTokenExpiresAt: "2030-01-01T01:00:00.000Z",
      rotationCount: 1,
      labels: [],
    };
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByLabelText("Current value keeps working"));
    await user.click(screen.getByRole("option", { name: "For 1 hour" }));
    await user.click(screen.getByRole("button", { name: "Rotate key" }));

    expect(await screen.findByText("archestra_new_value")).toBeVisible();
    expect(rotateBodies).toEqual([{ gracePeriodSeconds: 3600 }]);
    expect(
      screen.getByText(/previous value keeps working until/),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Rotate key" }),
    ).not.toBeInTheDocument();
  });

  it("tells a manager who did not create the key where the value is", async () => {
    rotateResponse = {
      ...makeVirtualKey({ id: KEY_ID }),
      previousTokenExpiresAt: "2030-01-02T00:00:00.000Z",
      rotationCount: 1,
    };
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Rotate key" }));

    expect(
      await screen.findByText(/owner can copy the new value/),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /copy/i }),
    ).not.toBeInTheDocument();
    expect(rotateBodies).toEqual([{ gracePeriodSeconds: 86400 }]);
  });
});

function renderDialog() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RotateVirtualKeyDialog
        virtualKey={{ id: KEY_ID, name: "CI key" }}
        onOpenChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
}
