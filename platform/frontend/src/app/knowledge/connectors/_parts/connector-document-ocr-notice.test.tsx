import { DocsPage, getDocsUrl } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { ConnectorDocumentOcrNotice } from "./connector-document-ocr-notice";

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

function mockOrganizationOcr(configured: boolean) {
  vi.mocked(useOrganization).mockReturnValue({
    data: {
      id: "organization-1",
      ocrChatApiKeyId: configured ? "ocr-key" : null,
      ocrModel: configured ? "vision-model" : null,
    },
  } as ReturnType<typeof useOrganization>);
}

beforeEach(() => {
  localStorage.clear();
  mockOrganizationOcr(false);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
});

describe("ConnectorDocumentOcrNotice", () => {
  it("shows a quiet note with settings and documentation links while OCR is not configured", async () => {
    render(<ConnectorDocumentOcrNotice connectorType="gdrive" />);

    const note = await screen.findByRole("note");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(note).toHaveTextContent("Document OCR is not set up.");
    expect(note).toHaveTextContent(
      "Scanned or image-only PDF pages in this source are skipped",
    );
    expect(screen.getByRole("link", { name: "OCR settings" })).toHaveAttribute(
      "href",
      "/settings/knowledge#document-ocr",
    );
    // Through ExternalDocsLink, so a fully white-labeled deployment drops the
    // link entirely instead of pointing at the vendor's docs site.
    expect(screen.getByRole("link", { name: /Learn more/ })).toHaveAttribute(
      "href",
      getDocsUrl(DocsPage.PlatformKnowledge, "document-ocr"),
    );
  });

  it("renders nothing once OCR is configured", () => {
    mockOrganizationOcr(true);

    const { container } = render(
      <ConnectorDocumentOcrNotice connectorType="gdrive" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("does not show on connectors that carry no PDFs", () => {
    const { container } = render(
      <ConnectorDocumentOcrNotice connectorType="jira" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the note dismissed for the user until OCR has been configured in between", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <ConnectorDocumentOcrNotice connectorType="sharepoint" />,
    );
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    // A fresh mount for the same user stays quiet.
    unmount();
    const { rerender } = render(
      <ConnectorDocumentOcrNotice connectorType="sharepoint" />,
    );
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    // Configuring OCR resets the dismissal: clearing it again later tells the
    // admin again rather than silently skipping scans forever.
    mockOrganizationOcr(true);
    rerender(<ConnectorDocumentOcrNotice connectorType="sharepoint" />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    mockOrganizationOcr(false);
    rerender(<ConnectorDocumentOcrNotice connectorType="sharepoint" />);
    expect(await screen.findByRole("note")).toBeInTheDocument();
  });

  it("scopes dismissal to the signed-in user", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConnectorDocumentOcrNotice connectorType="onedrive" />,
    );
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));

    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-2" } },
    } as ReturnType<typeof useSession>);
    rerender(<ConnectorDocumentOcrNotice connectorType="onedrive" />);

    expect(await screen.findByRole("note")).toBeInTheDocument();
  });
});
