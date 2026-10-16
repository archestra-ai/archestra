import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter } from "next/navigation";
import { createElement, type ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { useChatWithKnowledgeBase } from "./use-chat-with-knowledge-base";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
const push = vi.fn();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  push.mockReset();
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as unknown as ReturnType<typeof useSession>);
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it.each([
  false,
  true,
])("keeps existing knowledge-base assignments when the requested base is already attached: %s", async (alreadyAttached) => {
  const assignments = alreadyAttached
    ? ["existing-base", "new-base"]
    : ["existing-base"];
  const updates: unknown[] = [];
  const detailIds: string[] = [];
  server.use(
    http.get(`${origin}/api/agents/options`, () =>
      HttpResponse.json([
        { id: "other-agent", name: "Knowledge helper", authorId: "other-user" },
        { id: "selected-agent", name: "Knowledge helper", authorId: "user-1" },
      ]),
    ),
    http.get(`${origin}/api/agents/:id`, ({ params }) => {
      detailIds.push(String(params.id));
      return HttpResponse.json({
        id: params.id,
        knowledgeBaseIds: assignments,
      });
    }),
    http.put(`${origin}/api/agents/selected-agent`, async ({ request }) => {
      updates.push(await request.json());
      return HttpResponse.json({ id: "selected-agent" });
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(() => useChatWithKnowledgeBase(), { wrapper });
  await act(async () => {
    await hook.result.current.startChat({
      id: "new-base",
      name: "Knowledge helper",
    } as Parameters<typeof hook.result.current.startChat>[0]);
  });
  expect(detailIds).toEqual(["selected-agent"]);
  expect(updates).toEqual(
    alreadyAttached
      ? []
      : [{ knowledgeBaseIds: ["existing-base", "new-base"] }],
  );
  expect(push).toHaveBeenCalledWith("/chat/new?agent_id=selected-agent");
  hook.unmount();
  queryClient.clear();
});
