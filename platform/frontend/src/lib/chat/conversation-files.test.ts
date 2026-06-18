import { describe, expect, it } from "vitest";
import { assembleFileSections } from "@/lib/chat/conversation-files";

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
  myFiles: [
    {
      id: "x1",
      name: "q2.csv",
      mimeType: "text/csv",
      contentUrl: "/api/skill-sandbox/artifacts/x1",
      createdAt: "2026-06-08T00:00:00.000Z",
    },
  ],
  projectName: null,
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
    const { generated, attachments, myFiles } = assembleFileSections({
      files: null,
      artifact: "# hello",
    });
    expect(generated.map((f) => f.id)).toEqual(["artifact"]);
    expect(attachments).toEqual([]);
    expect(myFiles).toEqual([]);
  });

  it("maps myFiles to the my-file source with the artifact byte URL", () => {
    const { myFiles } = assembleFileSections({
      files: apiFiles,
      artifact: null,
    });
    expect(myFiles).toEqual([
      {
        id: "x1",
        name: "q2.csv",
        mimeType: "text/csv",
        contentUrl: "/api/skill-sandbox/artifacts/x1",
        source: "my-file",
      },
    ]);
  });

  it("titles the myFiles section by scope: project vs personal", () => {
    const personal = assembleFileSections({ files: apiFiles, artifact: null });
    expect(personal.myFilesTitle).toBe("My Files");

    const project = assembleFileSections({
      files: { ...apiFiles, projectName: "hello" },
      artifact: null,
    });
    expect(project.myFilesTitle).toBe("Project files");
  });
});
