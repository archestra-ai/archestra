import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { organizationKeys } from "@/lib/organization.query";
import { makeSession } from "@/mocks/data/auth";
import { makeOrganization } from "@/mocks/data/organization";
import { AppearanceSettings } from "./appearance-settings";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/components/editor");
vi.mock("sonner");
const { setHeader, push } = vi.hoisted(() => ({
  setHeader: vi.fn(),
  push: vi.fn(),
}));
vi.mock("../../layout", () => ({ useSetSettingsPageHeader: () => setHeader }));

const API = "http://localhost:9000";
const server = setupServer();
let organization = makeOrganization();
let notification: archestraApiTypes.GetSiteNotificationSettingsResponses["200"];
let patches: Record<string, unknown>[];
let noticeWrites: { method: string; body?: unknown }[];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => server.resetHandlers());
beforeEach(() => {
  vi.clearAllMocks();
  archestraApiClient.setConfig({ baseUrl: API });
  organization = makeOrganization({
    chatPlaceholders: ["Ask a question"],
    chatLinks: [{ label: "Help", url: "https://docs.example.com" }],
    onboardingWizard: {
      label: "Start here",
      pages: [{ content: "# Welcome", image: null }],
    },
  });
  notification = {
    id: "notice-1",
    content: "**Welcome** to the workspace.",
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    isActive: true,
  };
  patches = [];
  noticeWrites = [];
  vi.mocked(usePathname).mockReturnValue("/settings/appearance/branding");
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(useSession).mockReturnValue({
    data: makeSession(),
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  server.use(
    http.get(`${API}/api/organization`, () => HttpResponse.json(organization)),
    http.get(`${API}/api/site-notification/settings`, () =>
      HttpResponse.json(notification),
    ),
    http.patch(
      `${API}/api/organization/appearance-settings`,
      async ({ request }) => {
        const patch = (await request.json()) as Record<string, unknown>;
        patches.push(patch);
        organization = { ...organization, ...patch };
        return HttpResponse.json(organization);
      },
    ),
    http.put(`${API}/api/site-notification/:id`, async ({ request }) => {
      const body = await request.json();
      noticeWrites.push({ method: "PUT", body });
      if (!notification) return new HttpResponse(null, { status: 404 });
      notification = { ...notification, ...(body as object) };
      return HttpResponse.json(notification);
    }),
    http.post(`${API}/api/site-notification`, async ({ request }) => {
      const body = (await request.json()) as {
        content: string;
        expiresAt?: string;
      };
      noticeWrites.push({ method: "POST", body });
      notification = {
        id: "created-notice",
        content: body.content,
        expiresAt: body.expiresAt ?? null,
        isActive: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      return HttpResponse.json(notification);
    }),
    http.delete(`${API}/api/site-notification/:id`, () => {
      noticeWrites.push({ method: "DELETE" });
      notification = null;
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <AppearanceSettings />
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    client,
    navigate(section: string) {
      vi.mocked(usePathname).mockReturnValue(`/settings/appearance/${section}`);
      view.rerender(tree());
    },
  };
}

const save = () => screen.getByRole("button", { name: "Save" });

describe("Appearance settings", () => {
  it("keeps drafts across pages and saves only changed settings without previewing the theme", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    await user.type(
      await screen.findByRole("textbox", { name: "App Name" }),
      "Workspace",
    );
    await user.click(screen.getByRole("button", { name: "Claude" }));
    expect(patches).toEqual([]);
    view.navigate("chat");
    await user.clear(
      screen.getByRole("textbox", { name: "Chat placeholder 1" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Chat placeholder 1" }),
      "New prompt",
    );
    await user.click(
      screen.getByRole("switch", { name: "Show detailed errors" }),
    );
    await user.click(save());
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument(),
    );
    expect(patches).toEqual([
      {
        appName: "Workspace",
        theme: "claude",
        chatPlaceholders: ["New prompt"],
        slimChatErrorUi: true,
      },
    ]);
    expect(noticeWrites).toEqual([]);
    view.navigate("branding");
    expect(screen.getByRole("textbox", { name: "App Name" })).toHaveValue(
      "Workspace",
    );
    expect(setHeader).toHaveBeenLastCalledWith({
      title: "Appearance",
      description: "Name, logos, and colors for your organization.",
    });
  });

  it("saves a new chat layout and its headline animation", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    view.navigate("chat");
    expect(
      await screen.findByRole("radio", { name: /^Classic/ }),
    ).toBeChecked();
    expect(
      screen.queryByRole("switch", { name: "Animate headline" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /^Greeting/ }));
    await user.click(screen.getByRole("switch", { name: "Animate headline" }));
    await user.click(save());

    await waitFor(() =>
      expect(patches).toEqual([
        { chatLandingStyle: "greeting", animateChatLandingHeadline: false },
      ]),
    );
  });

  it("treats an organization cached before the layout setting as Classic", async () => {
    const {
      chatLandingStyle: _style,
      animateChatLandingHeadline: _animate,
      ...cachedBeforeUpgrade
    } = organization;
    organization = cachedBeforeUpgrade as typeof organization;
    const view = renderSettings();
    view.navigate("chat");

    expect(
      await screen.findByRole("radio", { name: /^Classic/ }),
    ).toBeChecked();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("preserves a dirty field across refetches and discards to the latest server values", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    await user.type(
      await screen.findByRole("textbox", { name: "App Name" }),
      "Draft name",
    );
    organization = {
      ...organization,
      appName: "Remote name",
      footerText: "Remote footer",
    };
    await act(() =>
      view.client.invalidateQueries({ queryKey: organizationKeys.details() }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Footer Text" })).toHaveValue(
        "Remote footer",
      ),
    );
    expect(screen.getByRole("textbox", { name: "App Name" })).toHaveValue(
      "Draft name",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "App Name" })).toHaveValue(
      "Remote name",
    );
    expect(patches).toEqual([]);
  });

  it("preserves drafts when a background refresh fails", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    await user.type(
      await screen.findByRole("textbox", { name: "App Name" }),
      "Keep this draft",
    );
    server.use(
      http.get(
        `${API}/api/organization`,
        () =>
          HttpResponse.json(
            { error: { message: "Unavailable" } },
            { status: 503 },
          ),
        { once: true },
      ),
    );
    await act(() =>
      view.client.invalidateQueries({ queryKey: organizationKeys.details() }),
    );
    expect(
      await screen.findByText("Could not refresh appearance settings"),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "App Name" })).toHaveValue(
      "Keep this draft",
    );
    expect(save()).toBeEnabled();
    expect(patches).toEqual([]);
  });

  it("validates incomplete links on save and preserves the invalid draft", async () => {
    const user = userEvent.setup();
    vi.mocked(usePathname).mockReturnValue("/settings/appearance/chat");
    renderSettings();
    await user.clear(
      await screen.findByRole("textbox", { name: "Link 1 URL" }),
    );
    await user.click(save());
    expect(
      await screen.findByText("Enter a valid HTTP or HTTPS URL."),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Link 1 URL" })).toHaveValue("");
    expect(patches).toEqual([]);
  });

  it("keeps notification edits local until Save, including expiration and removal", async () => {
    const user = userEvent.setup();
    vi.mocked(usePathname).mockReturnValue("/settings/appearance/other");
    renderSettings();
    await user.click(
      await screen.findByRole("button", { name: "Edit site notification" }),
    );
    let dialog = screen.getByRole("dialog");
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Notification content" }),
      { target: { value: "# Discard this" } },
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(
      screen.getByRole("button", { name: "Edit site notification" }),
    );
    dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("textbox", { name: "Notification content" }),
    ).toHaveValue("**Welcome** to the workspace.");
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Notification content" }),
      { target: { value: "# Maintenance" } },
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Preview Markdown" }),
    );
    expect(
      within(dialog).getByRole("heading", { name: "Maintenance" }),
    ).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Expires" }));
    await user.click(screen.getByRole("button", { name: "7 days" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Keep changes" }),
    );
    expect(noticeWrites).toEqual([]);
    await user.click(save());
    await waitFor(() =>
      expect(noticeWrites).toEqual([
        {
          method: "PUT",
          body: {
            content: "# Maintenance",
            expiresAt: expect.any(String),
            isActive: true,
          },
        },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", { name: "Remove site notification" }),
    );
    expect(noticeWrites).toHaveLength(1);
    await user.click(save());
    await waitFor(() =>
      expect(noticeWrites.at(-1)).toEqual({ method: "DELETE" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No announcement configured.")).toBeVisible();
  });

  it("creates a notification only after the page is saved", async () => {
    notification = null;
    vi.mocked(usePathname).mockReturnValue("/settings/appearance/other");
    const user = userEvent.setup();
    renderSettings();
    await user.click(
      await screen.findByRole("button", { name: "Add notification" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Notification content" }),
      { target: { value: "New announcement" } },
    );
    await user.click(screen.getByRole("button", { name: "Keep changes" }));
    expect(noticeWrites).toEqual([]);
    await user.click(save());
    await waitFor(() =>
      expect(noticeWrites).toEqual([
        { method: "POST", body: { content: "New announcement" } },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("rejects invalid assets and saves a valid asset through the shared save bar", async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByRole("textbox", { name: "App Name" });
    const input = screen.getByLabelText("Logo · Light", { exact: true });
    fireEvent.change(input, {
      target: {
        files: [new File(["bad"], "image.jpg", { type: "image/jpeg" })],
      },
    });
    expect(screen.getByText("Upload a PNG or SVG file.")).toBeVisible();
    fireEvent.change(input, {
      target: {
        files: [new File(["image"], "image.png", { type: "image/png" })],
      },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Replace Logo · Light" }),
      ).toBeVisible(),
    );
    expect(patches).toEqual([]);
    await user.click(save());
    await waitFor(() =>
      expect(patches).toEqual([{ logo: "data:image/png;base64,aW1hZ2U=" }]),
    );
  });

  it("retains a notification draft after a failed save and can retry", async () => {
    const user = userEvent.setup();
    vi.mocked(usePathname).mockReturnValue("/settings/appearance/other");
    server.use(
      http.put(
        `${API}/api/site-notification/:id`,
        () =>
          HttpResponse.json(
            { error: { message: "Unavailable" } },
            { status: 503 },
          ),
        { once: true },
      ),
    );
    renderSettings();
    await user.click(
      await screen.findByRole("button", { name: "Edit site notification" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Notification content" }),
      { target: { value: "Retry this announcement" } },
    );
    await user.click(screen.getByRole("button", { name: "Keep changes" }));
    await user.click(save());
    await waitFor(() => expect(save()).toBeEnabled());
    expect(screen.getByText("Retry this announcement")).toBeVisible();
    await user.click(save());
    await waitFor(() => expect(noticeWrites).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("stages onboarding pages in the dialog and rejects empty pages", async () => {
    const user = userEvent.setup();
    vi.mocked(usePathname).mockReturnValue("/settings/appearance/other");
    renderSettings();
    await user.click(await screen.findByRole("button", { name: "Add page" }));
    await user.click(screen.getByRole("button", { name: "Keep page" }));
    expect(screen.getByText("Add content or an image.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("button", { name: "Edit onboarding page 2" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add page" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Page content" }), {
      target: { value: "## Second page" },
    });
    await user.click(screen.getByRole("button", { name: "Keep page" }));
    expect(patches).toEqual([]);
    await user.click(save());
    await waitFor(() =>
      expect(patches).toEqual([
        {
          onboardingWizard: {
            label: "Start here",
            pages: [
              { content: "# Welcome", image: null },
              { content: "## Second page", image: null },
            ],
          },
        },
      ]),
    );
  });

  it("lets read-only roles inspect Markdown without editing or saving", async () => {
    const user = userEvent.setup();
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: !permissions.organizationSettings?.includes("update"),
          isPending: false,
        }) as ReturnType<typeof useHasPermissions>,
    );
    const view = renderSettings();
    expect(
      await screen.findByRole("textbox", { name: "App Name" }),
    ).toBeDisabled();
    view.navigate("other");
    await user.click(
      screen.getByRole("button", { name: "View onboarding page 1" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Page content" }),
    ).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "Keep page" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Preview Markdown" }));
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeVisible();
    expect(patches).toEqual([]);
    expect(noticeWrites).toEqual([]);
  });
});
