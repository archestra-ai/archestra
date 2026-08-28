import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
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
import { UploadFileDialog } from "@/app/knowledge/files/_parts/upload-file-dialog";

const API_ORIGIN = "http://localhost:9000";
const CREATE_DIRECTORY_URL = `${API_ORIGIN}/api/knowledge-directories`;

const selectState = vi.hoisted(() => ({
  onValueChange: undefined as ((value: string) => void) | undefined,
  value: undefined as string | undefined,
}));

vi.mock("sonner");

vi.mock("@/app/knowledge/files/_parts/file-visibility-selector", () => ({
  FileVisibilitySelector: () => <div>Visibility</div>,
}));

// Radix Select relies on browser layout APIs that jsdom does not implement.
// This keeps the real dialog and mutation flow while replacing only the
// inaccessible listbox interaction; Chrome verification covers the real
// selector below this test layer.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children: React.ReactNode;
    onValueChange?: (value: string) => void;
    value?: string;
  }) => {
    selectState.onValueChange = onValueChange;
    selectState.value = value;
    return <div>{children}</div>;
  },
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button" role="combobox" aria-expanded="false">
      {children}
    </button>
  ),
  SelectValue: () => <span>{selectState.value}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    icon,
    value,
  }: {
    children: React.ReactNode;
    icon?: React.ReactNode;
    value: string;
  }) => (
    <button type="button" onClick={() => selectState.onValueChange?.(value)}>
      {icon}
      <span>{children}</span>
    </button>
  ),
  SelectSeparator: () => <hr />,
}));

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  vi.clearAllMocks();
  selectState.onValueChange = undefined;
  selectState.value = undefined;
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("UploadFileDialog", () => {
  it("creates and selects a directory without leaving the upload flow", async () => {
    const createdDirectory = {
      id: "directory-created-during-upload",
      organizationId: "org-1",
      name: "New uploads",
      visibility: "org-wide",
      createdBy: "user-1",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      teamIds: [],
      fileCount: 0,
    };
    let requestBody: unknown;
    server.use(
      http.post(CREATE_DIRECTORY_URL, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json(createdDirectory);
      }),
    );

    render(
      <QueryClientProvider client={createQueryClient()}>
        <UploadFileDialog
          open
          onOpenChange={vi.fn()}
          directories={[]}
          defaultDirectoryId={null}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create directory…" }));
    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: createdDirectory.name },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(requestBody).toEqual({
        name: createdDirectory.name,
        visibility: "org-wide",
        teamIds: [],
      }),
    );
    expect(screen.queryByText("New directory")).not.toBeInTheDocument();
    expect(screen.getByText("Upload documents")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveTextContent(createdDirectory.id);
    expect(
      screen.getByRole("button", { name: createdDirectory.name }),
    ).toBeInTheDocument();
  });
});

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}
