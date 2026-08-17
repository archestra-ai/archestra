import { describe, expect, it } from "vitest";
import {
  assembleFileSections,
  attachmentIdFromUrl,
  type ConversationFileItem,
  deleteTargetFor,
  persistentFilesSection,
} from "@/lib/chat/conversation-files";

function fileItem(
  source: ConversationFileItem["source"],
  id = source,
): ConversationFileItem {
  return {
    id,
    name: `${id}.bin`,
    mimeType: "text/plain",
    contentUrl: "",
    source,
  };
}

const apiFiles = {
  generated: [
    {
      id: "g1",
      name: "chart.png",
      mimeType: "image/png",
      contentUrl: "/api/skill-sandbox/artifacts/g1",
      createdAt: "2026-06-08T00:00:00.000Z",
    },
  ],
  attachments: [
    {
      id: "a1",
      name: "notes.pdf",
      mimeType: "application/pdf",
      contentUrl: "/api/chat/attachments/a1/content",
      createdAt: "2026-06-08T00:00:00.000Z",
    },
  ],
  projectFiles: [
    {
      id: "x1",
      name: "q2.csv",
      mimeType: "text/csv",
      contentUrl: "/api/skill-sandbox/artifacts/x1",
      createdAt: "2026-06-08T00:00:00.000Z",
    },
  ],
  projectName: "hello",
  canManageFiles: true,
};

describe("assembleFileSections", () => {
  it("prepends artifact.md to generated when an artifact exists", () => {
    const { generated, attachments } = assembleFileSections({
      files: apiFiles,
      artifact: "# hello",
    });
    expect(generated.map((f) => f.id)).toEqual(["artifact", "g1"]);
    expect(generated[0]).toMatchObject({
      id: "artifact",
      name: "artifact.md",
      mimeType: "text/markdown",
      source: "artifact",
    });
    expect(generated[1].source).toBe("generated");
    expect(attachments).toEqual([
      {
        id: "a1",
        name: "notes.pdf",
        mimeType: "application/pdf",
        contentUrl: "/api/chat/attachments/a1/content",
        source: "attachment",
      },
    ]);
  });

  it("omits artifact.md when artifact is empty or whitespace", () => {
    expect(
      assembleFileSections({ files: apiFiles, artifact: "   " }).generated.map(
        (f) => f.id,
      ),
    ).toEqual(["g1"]);
    expect(
      assembleFileSections({ files: apiFiles, artifact: null }).generated.map(
        (f) => f.id,
      ),
    ).toEqual(["g1"]);
  });

  it("handles a null files payload (artifact only)", () => {
    const { generated, attachments, projectFiles } = assembleFileSections({
      files: null,
      artifact: "# hello",
    });
    expect(generated.map((f) => f.id)).toEqual(["artifact"]);
    expect(attachments).toEqual([]);
    expect(projectFiles).toEqual([]);
  });

  it("maps project files to the project source with the byte URL", () => {
    const { projectFiles } = assembleFileSections({
      files: apiFiles,
      artifact: null,
    });
    expect(projectFiles).toEqual([
      {
        id: "x1",
        name: "q2.csv",
        mimeType: "text/csv",
        contentUrl: "/api/skill-sandbox/artifacts/x1",
        source: "project",
      },
    ]);
  });
});

describe("persistentFilesSection", () => {
  it("labels a project chat's persistent files as shared with the project", () => {
    expect(persistentFilesSection("proj_1")).toEqual({
      title: "Project files",
      description: "shared with the whole project",
    });
  });

  it("labels a personal chat's persistent files as chat-scoped", () => {
    const chatScoped = {
      title: "Chat files",
      description: "saved to a project if you create one from this chat",
    };
    expect(persistentFilesSection(null)).toEqual(chatScoped);
    expect(persistentFilesSection(undefined)).toEqual(chatScoped);
  });
});

describe("deleteTargetFor", () => {
  it("routes attachments to the attachment endpoint", () => {
    expect(deleteTargetFor(fileItem("attachment"))).toEqual({
      kind: "attachment",
    });
  });

  it("routes generated and project files to the artifact endpoint", () => {
    expect(deleteTargetFor(fileItem("generated"))).toEqual({
      kind: "artifact",
    });
    expect(deleteTargetFor(fileItem("project"))).toEqual({ kind: "artifact" });
  });
});

describe("attachmentIdFromUrl", () => {
  const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

  it("reads the id out of an attachment byte url", () => {
    expect(attachmentIdFromUrl(`/api/chat/attachments/${id}/content`)).toBe(id);
  });

  it("reads it from an absolute url, and past a query string", () => {
    expect(
      attachmentIdFromUrl(
        `https://app.example.com/api/chat/attachments/${id}/content`,
      ),
    ).toBe(id);
    expect(attachmentIdFromUrl(`/api/chat/attachments/${id}/content?v=2`)).toBe(
      id,
    );
  });

  it("returns null for anything that is not a chat attachment", () => {
    // A sandbox artifact and an inline image are both file parts too; neither
    // can be promoted, so neither may yield an id.
    expect(attachmentIdFromUrl("/api/skill-sandbox/artifacts/g1")).toBeNull();
    expect(
      attachmentIdFromUrl("data:image/png;base64,iVBORw0KGgo="),
    ).toBeNull();
    expect(attachmentIdFromUrl("")).toBeNull();
  });

  it("rejects a path segment that is not a uuid", () => {
    expect(
      attachmentIdFromUrl("/api/chat/attachments/not-a-uuid/content"),
    ).toBeNull();
  });
});
