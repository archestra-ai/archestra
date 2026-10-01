import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useScheduleTriggers } from "@/lib/schedule-trigger.query";
import { useDeleteProject } from "./projects.query";

vi.mock("sonner");

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("deletes without refetching the confirmation dialog's schedules or showing a not-found toast", async () => {
  let deleted = false;
  const scheduleRequests: (string | null)[] = [];
  server.use(
    http.get(`${API_ORIGIN}/api/schedule-triggers`, ({ request }) => {
      const projectId = new URL(request.url).searchParams.get("projectId");
      scheduleRequests.push(projectId);
      if (deleted && projectId === "project-1") {
        return HttpResponse.json(
          {
            error: {
              message: "Project not found",
              type: "api_not_found_error",
            },
          },
          { status: 404 },
        );
      }
      return HttpResponse.json({
        data: [],
        pagination: {
          currentPage: 1,
          limit: 50,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      });
    }),
    http.delete(`${API_ORIGIN}/api/projects/project-1`, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  // The confirmation's count query remains mounted until mutateAsync resolves.
  const { result, unmount } = renderHook(
    () => ({
      confirmation: useScheduleTriggers({ projectId: "project-1" }),
      otherProject: useScheduleTriggers({ projectId: "project-2" }),
      schedules: useScheduleTriggers(),
      deletion: useDeleteProject(),
    }),
    { wrapper },
  );
  await waitFor(() => expect(scheduleRequests).toHaveLength(3));
  await waitFor(() => expect(result.current.confirmation.isSuccess).toBe(true));

  await act(async () => {
    await result.current.deletion.mutateAsync({ id: "project-1" });
  });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));

  expect(deleted).toBe(true);
  expect(toast.success).toHaveBeenCalledTimes(1);
  expect(toast.error).not.toHaveBeenCalled();
  expect(scheduleRequests.filter((id) => id === "project-1")).toHaveLength(1);
  expect(scheduleRequests.filter((id) => id === "project-2")).toHaveLength(2);
  expect(scheduleRequests.filter((id) => id === null)).toHaveLength(2);
  unmount();
  queryClient.clear();
});
