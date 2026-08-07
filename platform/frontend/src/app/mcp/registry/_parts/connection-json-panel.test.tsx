import { act, fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/config.query");
vi.mock("sonner");

// Monaco doesn't render in jsdom — a textarea is enough to drive the
// value/onChange contract the panel depends on.
vi.mock("@/components/editor", () => ({
  Editor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (value: string | undefined) => void;
  }) => (
    <textarea
      data-testid="json-editor"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

// Radix Select doesn't open in jsdom — a flat control exposing the same
// value/onValueChange/disabledReasons contract drives the panel's format
// logic (the real McpJsonFormatSelect is presentation only).
vi.mock("./mcp-json-format-select", () => {
  const NAMES: Record<string, string> = {
    mcpServers: "Claude Code",
    servers: "VS Code / Copilot",
    registry: "MCP Registry",
  };
  return {
    McpJsonFormatSelect: ({
      value,
      onValueChange,
      disabledReasons,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      disabledReasons: Record<string, string>;
    }) => (
      <div
        role="combobox"
        aria-label="JSON format"
        aria-expanded={false}
        aria-controls="format-options"
        tabIndex={0}
        data-disabled-reasons={JSON.stringify(disabledReasons)}
      >
        <span>{NAMES[value]}</span>
        {Object.keys(NAMES).map((format) => (
          <button
            key={format}
            type="button"
            data-testid={`format-option-${format}`}
            disabled={format in disabledReasons}
            onClick={() => onValueChange(format)}
          >
            <span>{format}</span>
          </button>
        ))}
      </div>
    ),
  };
});

import { toast } from "sonner";
import { useFeature } from "@/lib/config/config.query";
import {
  ConnectionJsonPanel,
  type ConnectionJsonPanelController,
} from "./connection-json-panel";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { parseMcpConfigText } from "./mcp-config-import";

function remoteValues(overrides?: Partial<McpCatalogFormValues>) {
  const parsed = parseMcpConfigText(
    JSON.stringify({ type: "http", url: "https://old.example.com/mcp" }),
  );
  if (parsed.status !== "servers") throw new Error("fixture did not parse");
  return {
    ...parsed.servers[0].values,
    name: "existing",
    ...overrides,
  } as McpCatalogFormValues;
}

function Harness({
  values,
  mode,
  controllerRef,
  onDraftStateChange,
  onForm,
}: {
  values: McpCatalogFormValues;
  mode: "create" | "edit";
  controllerRef?: React.MutableRefObject<ConnectionJsonPanelController | null>;
  onDraftStateChange?: (hasPendingDraft: boolean) => void;
  onForm?: (form: ReturnType<typeof useForm<McpCatalogFormValues>>) => void;
}) {
  const form = useForm<McpCatalogFormValues>({ defaultValues: values });
  onForm?.(form);
  return (
    <ConnectionJsonPanel
      form={form}
      mode={mode}
      appName="TestApp"
      controllerRef={controllerRef}
      onDraftStateChange={onDraftStateChange}
    />
  );
}

const editorValue = () =>
  (screen.getByTestId("json-editor") as HTMLTextAreaElement).value;

const pasteIntoEditor = (value: string) =>
  fireEvent.change(screen.getByTestId("json-editor"), { target: { value } });

const MULTI_SERVER_TEXT = JSON.stringify({
  mcpServers: {
    alpha: { type: "http", url: "https://alpha.example.com" },
    beta: { command: "npx", args: ["-y", "beta-server"] },
  },
});

describe("ConnectionJsonPanel", () => {
  it("mirrors the current config as a viewer — the import pipeline appears only once edited", () => {
    // Untouched, the panel is a live mirror of the form: no Apply/Discard,
    // no changes list — just the JSON with its export chrome.
    vi.mocked(useFeature).mockReturnValue(true);
    render(<Harness values={remoteValues()} mode="edit" />);

    expect(editorValue()).toContain('"mcpServers"');
    expect(editorValue()).toContain('"existing"');
    expect(editorValue()).toContain("https://old.example.com/mcp");

    expect(screen.getByText(/Follows the form fields/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Apply/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Discard/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Changes")).not.toBeInTheDocument();

    // View/export affordances are anchored in the chrome bar.
    expect(screen.getByLabelText("Copy JSON")).toBeInTheDocument();
    expect(screen.getByLabelText("Download JSON")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "JSON format" }),
    ).toBeInTheDocument();
    // The title bar carries the standing paste/import invitation.
    expect(screen.getByText(/Paste a config from a README/)).toBeVisible();

    // Editing the JSON freezes the mirror into a pending draft: the changes
    // list appears and Apply/Discard arm.
    pasteIntoEditor(
      JSON.stringify({ type: "http", url: "https://new.example.com" }),
    );
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText(/Server URL/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply changes/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Discard/ })).toBeEnabled();
    // A draft is not "your connection config" — the mirror footnote leaves
    // with the mirror.
    expect(
      screen.queryByText(/Follows the form fields/),
    ).not.toBeInTheDocument();
  });

  it("live-follows form edits while untouched", () => {
    // The panel sits inside the form, so the mirror must track every form
    // change — the old modal only had to seed once on open.
    vi.mocked(useFeature).mockReturnValue(true);
    let form: ReturnType<typeof useForm<McpCatalogFormValues>> | undefined;
    render(
      <Harness
        values={remoteValues()}
        mode="edit"
        onForm={(f) => {
          form = f;
        }}
      />,
    );
    expect(editorValue()).toContain("https://old.example.com/mcp");

    act(() => {
      form?.setValue("serverUrl", "https://moved.example.com/mcp");
    });
    expect(editorValue()).toContain("https://moved.example.com/mcp");
    // Still a mirror: following the form never arms the import pipeline.
    expect(
      screen.queryByRole("button", { name: /Apply/ }),
    ).not.toBeInTheDocument();
  });

  it("a pending draft freezes the mirror; Discard resumes following", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    let form: ReturnType<typeof useForm<McpCatalogFormValues>> | undefined;
    render(
      <Harness
        values={remoteValues()}
        mode="edit"
        onForm={(f) => {
          form = f;
        }}
      />,
    );

    const draft = JSON.stringify({
      type: "http",
      url: "https://draft.example.com",
    });
    pasteIntoEditor(draft);

    // Form edits beneath the draft must NOT clobber the frozen text…
    act(() => {
      form?.setValue("serverUrl", "https://meanwhile.example.com/mcp");
    });
    expect(editorValue()).toBe(draft);
    // …but the plan follows the live form: the changes list still compares
    // against the CURRENT values.
    expect(screen.getByText("Changes")).toBeInTheDocument();

    // Discard drops the draft and resumes mirroring the (changed) form.
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    expect(editorValue()).toContain("https://meanwhile.example.com/mcp");
    expect(
      screen.queryByRole("button", { name: /Apply/ }),
    ).not.toBeInTheDocument();
  });

  it("an empty create form shows the same mirrored anatomy (skeleton seed)", () => {
    // Start-from-scratch must not be a separate paste-first state: the empty
    // form serializes to a skeleton entry with the standard chrome.
    vi.mocked(useFeature).mockReturnValue(true);
    render(
      <Harness
        values={remoteValues({ name: "", serverUrl: "" })}
        mode="create"
      />,
    );

    expect(editorValue()).toContain('"mcpServers"');
    expect(editorValue()).toContain('"url": ""');
    expect(screen.getByText(/Follows the form fields/)).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "JSON format" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Copy JSON")).toBeInTheDocument();
    expect(screen.getByLabelText("Download JSON")).toBeInTheDocument();

    // Pasting over the skeleton arms the normal import pipeline.
    pasteIntoEditor(
      JSON.stringify({ type: "http", url: "https://new.example.com" }),
    );
    expect(screen.getByRole("button", { name: /Apply changes/ })).toBeEnabled();
  });

  it("switching the untouched select reseeds the mirror in that format", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    render(<Harness values={remoteValues()} mode="edit" />);
    expect(editorValue()).toContain('"mcpServers"');

    fireEvent.click(screen.getByTestId("format-option-servers"));
    expect(editorValue()).toContain('"servers"');
    // Still a mirror: the reseed must not arm the import pipeline.
    expect(
      screen.queryByRole("button", { name: /Apply/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps mirroring form edits after a format switch", () => {
    // The reseeded view is still the mirror — a form change after switching
    // to another format must re-render in THAT format, not bounce back.
    vi.mocked(useFeature).mockReturnValue(true);
    let form: ReturnType<typeof useForm<McpCatalogFormValues>> | undefined;
    render(
      <Harness
        values={remoteValues()}
        mode="edit"
        onForm={(f) => {
          form = f;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("format-option-servers"));
    expect(editorValue()).toContain('"servers"');

    act(() => {
      form?.setValue("serverUrl", "https://switched.example.com/mcp");
    });
    expect(editorValue()).toContain('"servers"');
    expect(editorValue()).toContain("https://switched.example.com/mcp");
  });

  it("falls back to the mcpServers view when a form edit invalidates the chosen format", () => {
    // The pick is sticky state but its validity depends on live form values:
    // VS Code chosen on a command-only local, then a Docker image typed in
    // (VS Code's schema rejects the dockerImage extension key). The mirror
    // must not keep rendering a format whose own select entry is disabled.
    vi.mocked(useFeature).mockReturnValue(true);
    const parsed = parseMcpConfigText(
      JSON.stringify({ command: "node", args: ["server.js"] }),
    );
    if (parsed.status !== "servers") throw new Error("fixture did not parse");
    let form: ReturnType<typeof useForm<McpCatalogFormValues>> | undefined;
    render(
      <Harness
        values={
          {
            ...parsed.servers[0].values,
            name: "cmd-local",
          } as McpCatalogFormValues
        }
        mode="edit"
        onForm={(f) => {
          form = f;
        }}
      />,
    );

    fireEvent.click(screen.getByTestId("format-option-servers"));
    expect(editorValue()).toContain('"servers"');

    act(() => {
      form?.setValue("localConfig.dockerImage", "ghcr.io/acme/server:1");
    });
    expect(
      screen.getByRole("combobox", { name: "JSON format" }),
    ).toHaveTextContent("Claude Code");
    expect(editorValue()).toContain('"mcpServers"');
    expect(editorValue()).toContain("ghcr.io/acme/server:1");
    // The fallback is a reseed, never a pending draft.
    expect(
      screen.queryByRole("button", { name: /Apply/ }),
    ).not.toBeInTheDocument();
  });

  it("switching the select on a pasted config converts it", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    render(<Harness values={remoteValues()} mode="create" />);
    pasteIntoEditor(
      JSON.stringify({
        servers: { pasted: { command: "npx", args: ["-y", "x"] } },
      }),
    );

    fireEvent.click(screen.getByTestId("format-option-mcpServers"));
    expect(editorValue()).toContain('"mcpServers"');
    expect(editorValue()).toContain('"npx"');
    // The converted text is still an importable, applyable config.
    expect(screen.getByRole("button", { name: /Apply changes/ })).toBeEnabled();
  });

  it("never disables a paste's own detected format in the select", () => {
    // Archestra normalizes a docker-run command to an image config it could
    // not itself re-export as VS Code servers format — but the pasted text
    // IS servers format, so its option must not read as impossible.
    vi.mocked(useFeature).mockReturnValue(true);
    render(<Harness values={remoteValues()} mode="create" />);
    pasteIntoEditor(
      JSON.stringify({
        servers: { x: { command: "docker", args: ["run", "-i", "img"] } },
      }),
    );
    const combo = screen.getByRole("combobox", { name: "JSON format" });
    const reasons = JSON.parse(
      combo.getAttribute("data-disabled-reasons") ?? "{}",
    );
    expect(reasons.servers).toBeUndefined();
  });

  it("footnotes masked secret values in the mirrored view", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    const parsed = parseMcpConfigText(
      JSON.stringify({ command: "npx", env: { API_TOKEN: "<token>" } }),
    );
    if (parsed.status !== "servers") throw new Error("fixture did not parse");
    render(
      <Harness
        values={
          { ...parsed.servers[0].values, name: "local" } as McpCatalogFormValues
        }
        mode="edit"
      />,
    );

    expect(screen.getByText(/Secret values are masked/)).toBeVisible();
  });

  it("calls out form-only config the JSON cannot express (single JSON surface)", () => {
    // The panel is the only JSON view — what the export format can't carry
    // (OAuth here) must be stated affirmatively in the mirrored view.
    vi.mocked(useFeature).mockReturnValue(true);
    render(
      <Harness values={remoteValues({ authMethod: "oauth" })} mode="edit" />,
    );

    expect(
      screen.getByText(/OAuth is configured for this server/),
    ).toBeVisible();
    expect(
      screen.getByText(/managed in the Authentication section/),
    ).toBeVisible();
  });

  it("auto-selects the format a pasted config is recognized as", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    render(<Harness values={remoteValues()} mode="create" />);

    // The mirrored view starts in the portable format…
    expect(
      screen.getByRole("combobox", { name: "JSON format" }),
    ).toHaveTextContent("Claude Code");

    // …and pasting a VS Code config flips the select to its format.
    pasteIntoEditor(
      JSON.stringify({
        servers: { pasted: { command: "npx", args: ["-y", "x"] } },
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "JSON format" }),
    ).toHaveTextContent("VS Code / Copilot");
  });

  it("multi-server pastes start unselected with Apply disabled", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    render(<Harness values={remoteValues()} mode="create" />);
    pasteIntoEditor(MULTI_SERVER_TEXT);

    expect(
      screen.getByText(/2 servers found — this entry holds one server/),
    ).toBeInTheDocument();
    // Multi-server pastes keep the recognition badge — the format select
    // (which can convert) only appears for a single recognized server.
    expect(screen.getByText("Claude Desktop / Cursor format")).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "JSON format" }),
    ).not.toBeInTheDocument();
    const apply = screen.getByRole("button", { name: /Apply selected server/ });
    expect(apply).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/alpha/));
    expect(
      screen.getByRole("button", { name: /Apply selected server/ }),
    ).toBeEnabled();
  });

  it("edit mode disables mismatched picker rows with a reason", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    render(<Harness values={remoteValues()} mode="edit" />);
    pasteIntoEditor(MULTI_SERVER_TEXT);

    // beta is self-hosted; this server is remote — its radio is disabled.
    const betaRadio = screen.getByRole("radio", { name: /beta/ });
    expect(betaRadio).toBeDisabled();
    expect(screen.getByText("beta").closest("label")).toHaveTextContent(
      "this server is Remote",
    );
    // The standing lock notice is present before any selection.
    expect(
      screen.getByText(/Server type is fixed after creation/),
    ).toBeInTheDocument();
  });

  it("shows the all-incompatible blocker when nothing in the paste matches", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    render(<Harness values={remoteValues()} mode="edit" />);
    pasteIntoEditor(JSON.stringify({ command: "npx", args: ["-y", "x"] }));

    expect(
      screen.getByText(/None of the pasted servers are Remote/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply/ })).toBeDisabled();
  });

  it("previews changes, applies once, resumes mirroring, and path-scoped Undo restores", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    let form: ReturnType<typeof useForm<McpCatalogFormValues>> | undefined;
    render(
      <Harness
        values={remoteValues()}
        mode="edit"
        onForm={(f) => {
          form = f;
        }}
      />,
    );
    pasteIntoEditor(
      JSON.stringify({ type: "http", url: "https://new.example.com" }),
    );

    // The changes list names the replacement before Apply.
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText(/Server URL/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Apply changes/ }));
    expect(form?.getValues("serverUrl")).toBe("https://new.example.com");
    // After Apply the panel is a mirror of the updated form again.
    expect(editorValue()).toContain("https://new.example.com");
    expect(
      screen.queryByRole("button", { name: /Apply/ }),
    ).not.toBeInTheDocument();

    // The receipt toast carries an Undo that reverts only touched paths.
    const toastCall = vi.mocked(toast.success).mock.calls.at(-1);
    expect(String(toastCall?.[0])).toContain("Applied");
    // Simulate a later edit to an UNTOUCHED field, then Undo.
    act(() => {
      form?.setValue("description", "added after import");
    });
    const action = (
      toastCall?.[1] as { action: { onClick: () => void } } | undefined
    )?.action;
    act(() => {
      action?.onClick();
    });
    expect(form?.getValues("serverUrl")).toBe("https://old.example.com/mcp");
    expect(form?.getValues("description")).toBe("added after import");
    // The mirror follows the undo too.
    expect(editorValue()).toContain("https://old.example.com/mcp");
  });

  it("Undo restores nested localConfig paths (deep-cloned snapshot)", () => {
    // RHF's getValues() returns a top-level spread whose nested objects alias
    // the live form — the snapshot MUST be deep-cloned or a self-hosted
    // import's Undo silently no-ops.
    vi.mocked(useFeature).mockReturnValue(true);
    const parsed = parseMcpConfigText(
      JSON.stringify({ command: "node", args: ["old.js"] }),
    );
    if (parsed.status !== "servers") throw new Error("fixture did not parse");
    const localValues = {
      ...parsed.servers[0].values,
      name: "local-server",
    } as McpCatalogFormValues;

    let form: ReturnType<typeof useForm<McpCatalogFormValues>> | undefined;
    render(
      <Harness
        values={localValues}
        mode="edit"
        onForm={(f) => {
          form = f;
        }}
      />,
    );
    pasteIntoEditor(
      JSON.stringify({
        command: "npx",
        args: ["-y", "new-server"],
        env: { NEW_VAR: "on" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Apply changes/ }));
    expect(form?.getValues("localConfig.command")).toBe("npx");
    expect(form?.getValues("localConfig.arguments")).toBe("-y\nnew-server");

    const toastCall = vi.mocked(toast.success).mock.calls.at(-1);
    const action = (
      toastCall?.[1] as { action: { onClick: () => void } } | undefined
    )?.action;
    act(() => {
      action?.onClick();
    });
    expect(form?.getValues("localConfig.command")).toBe("node");
    expect(form?.getValues("localConfig.arguments")).toBe("old.js");
    expect(form?.getValues("localConfig.environment")).toEqual([]);
  });

  it("collapse hides the block but keeps a pending draft flagged", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    render(<Harness values={remoteValues()} mode="edit" />);
    const draft = JSON.stringify({
      type: "http",
      url: "https://draft.example.com",
    });
    pasteIntoEditor(draft);
    expect(screen.getByText("Changes")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /Import & export/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The content is HIDDEN, not unmounted (forceMount keeps Monaco loaded),
    // and the pending draft is flagged in the title bar — the draft flag
    // outranks the standing paste invitation.
    expect(screen.getByText("Changes")).not.toBeVisible();
    expect(screen.getByText("Unapplied edits")).toBeVisible();
    expect(
      screen.queryByText(/Paste a config from a README/),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The draft text survives the collapse round-trip.
    expect(editorValue()).toBe(draft);
    expect(screen.getByText("Changes")).toBeVisible();
    expect(screen.queryByText("Unapplied edits")).not.toBeInTheDocument();
    expect(screen.getByText(/Paste a config from a README/)).toBeVisible();
  });

  it("reports draft state and routes an intercepted field paste via the controller", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    const onDraftStateChange = vi.fn();
    const controllerRef: {
      current: ConnectionJsonPanelController | null;
    } = { current: null };
    render(
      <Harness
        values={remoteValues()}
        mode="edit"
        controllerRef={controllerRef}
        onDraftStateChange={onDraftStateChange}
      />,
    );
    expect(onDraftStateChange).toHaveBeenLastCalledWith(false);

    // The form routes an intercepted field paste here: it lands as the
    // pending draft with the review pipeline armed.
    act(() => {
      controllerRef.current?.reviewPaste(
        JSON.stringify({ type: "http", url: "https://pasted.example.com" }),
      );
    });
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(onDraftStateChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    expect(onDraftStateChange).toHaveBeenLastCalledWith(false);
  });
});
