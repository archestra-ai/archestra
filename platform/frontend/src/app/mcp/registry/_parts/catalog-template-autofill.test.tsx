import { act, render } from "@testing-library/react";
import { type UseFormReturn, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner");

const useCatalogTemplateCandidatesMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mcp/external-mcp-catalog.query", () => ({
  useCatalogTemplateCandidates: useCatalogTemplateCandidatesMock,
}));

import { toast } from "sonner";
import { CatalogTemplateAutofill } from "./catalog-template-autofill";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";

const CONTEXT7_MANIFEST = {
  name: "upstash__context7",
  display_name: "Context7",
  description: "Up-to-date code documentation for LLMs",
  icon: "https://example.com/context7.png",
  server: {
    type: "local",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
  },
};

let capturedForm: UseFormReturn<McpCatalogFormValues> | undefined;

function Harness({ values }: { values: Partial<McpCatalogFormValues> }) {
  const form = useForm<McpCatalogFormValues>({
    defaultValues: values as McpCatalogFormValues,
  });
  capturedForm = form;
  return <CatalogTemplateAutofill form={form} />;
}

const TYPED_CONTEXT7 = {
  name: "",
  description: "",
  icon: null,
  serverType: "local",
  localConfig: {
    command: "npx",
    arguments: "-y\n@upstash/context7-mcp",
    dockerImage: "",
    environment: [],
  },
} as unknown as Partial<McpCatalogFormValues>;

describe("useCatalogTemplateAutofill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedForm = undefined;
    vi.mocked(toast.success).mockClear();
    useCatalogTemplateCandidatesMock.mockImplementation((term: unknown) => ({
      data: term === null ? undefined : [CONTEXT7_MANIFEST],
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fills pristine name, description, and logo on a strict match — with an Undo receipt", () => {
    render(<Harness values={TYPED_CONTEXT7} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const form = capturedForm;
    if (!form) throw new Error("harness did not render");
    expect(form.getValues("name")).toBe("Context7");
    expect(form.getValues("description")).toBe(
      "Up-to-date code documentation for LLMs",
    );
    expect(form.getValues("icon")).toBe("https://example.com/context7.png");
    // Auto-filled fields stay PRISTINE: the user's own first edit is what
    // freezes them, not ours.
    expect(form.formState.dirtyFields.name).toBeUndefined();

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast.success).mock
      .calls[0] as unknown as [string, { action: { onClick: () => void } }];
    expect(message).toContain('Matched "Context7" in the online catalog');
    expect(message).toContain("name, description, logo");

    // Undo restores the pre-fill defaults.
    act(() => {
      options.action.onClick();
    });
    expect(form.getValues("name")).toBe("");
    expect(form.getValues("icon")).toBeNull();
  });

  it("never overwrites fields the user already edited", () => {
    render(<Harness values={TYPED_CONTEXT7} />);
    const form = capturedForm;
    if (!form) throw new Error("harness did not render");
    act(() => {
      form.setValue("name", "My own name", { shouldDirty: true });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(form.getValues("name")).toBe("My own name");
    // The pristine fields still fill.
    expect(form.getValues("description")).toBe(
      "Up-to-date code documentation for LLMs",
    );
  });

  it("fills nothing (and stays silent) when no candidate strictly matches", () => {
    useCatalogTemplateCandidatesMock.mockImplementation(() => ({ data: [] }));
    render(<Harness values={TYPED_CONTEXT7} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(capturedForm?.getValues("name")).toBe("");
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });
});
