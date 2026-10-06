import {
  getArchestraToolFullName,
  TOOL_SHARE_FILE_PUBLICLY_SHORT_NAME,
} from "@archestra/shared";
import config from "@/config";
import {
  ConversationModel,
  FileNameExistsError,
  OrganizationModel,
  PublicFileLinkModel,
} from "@/models";
import AuditLogModel from "@/models/audit-log";
import { fileStore } from "@/skills-sandbox/file-store";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import { asSandboxId } from "@/types";
import { executeArchestraTool } from "./index";
import type { ArchestraContext } from "./types";

const SHARE = getArchestraToolFullName(TOOL_SHARE_FILE_PUBLICLY_SHORT_NAME);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

describe("share_file_publicly", () => {
  let context: ArchestraContext;
  let organizationId: string;
  let userId: string;
  let conversationId: string;

  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    config.skillsSandbox.enabled = true;
    config.publicFiles.baseUrl = "https://files.example.com";
    const agent = await makeAgent({ name: "Marketing Agent" });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId, { role: "member" });
    organizationId = agent.organizationId;
    userId = user.id;
    const conversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: agent.id,
      title: "Launch post",
    });
    conversationId = conversation.id;
    context = {
      agent: { id: agent.id, name: agent.name },
      organizationId,
      userId,
      conversationId,
    };
  });

  afterEach(() => vi.restoreAllMocks());

  const putFile = (filename: string, data: Buffer, mimeType = "image/png") =>
    fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId,
      filename,
      mimeType,
      sizeBytes: data.byteLength,
      data,
    });

  const enableSharing = () =>
    OrganizationModel.patch(organizationId, { allowPublicFileSharing: true });

  test("refuses with an admin-must-enable message while the org switch is off", async () => {
    const file = await putFile("banner.png", PNG);

    const result = await executeArchestraTool(
      SHARE,
      { fileId: file.id },
      context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("admin must enable");
    const { data } = await PublicFileLinkModel.listForOrganization({
      organizationId,
      pagination: { limit: 10, offset: 0 },
    });
    expect(data).toHaveLength(0);
  });

  test("refuses a file that is not an allowed media type, whatever its label", async () => {
    await enableSharing();
    // HTML mislabelled as an image: the bytes decide, not the stored mime.
    const file = await putFile(
      "page.png",
      Buffer.from("<html><script>alert(1)</script></html>"),
    );

    const result = await executeArchestraTool(
      SHARE,
      { fileId: file.id },
      context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "can't be shared publicly",
    );
  });

  test("publishes an image on the configured base URL and audits the new link", async () => {
    await enableSharing();
    const file = await putFile("banner", PNG);

    const result = await executeArchestraTool(
      SHARE,
      { fileId: file.id },
      context,
    );

    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const structured = result.structuredContent as {
      url: string;
      linkId: string;
    };
    // The extension is added for services that judge a link by its suffix.
    expect(structured.url).toMatch(
      /^https:\/\/files\.example\.com\/public-files\/[A-Za-z0-9_-]{32}\/banner\.png$/,
    );
    const { data } = await PublicFileLinkModel.listForOrganization({
      organizationId,
      pagination: { limit: 10, offset: 0 },
    });
    expect(data).toEqual([
      expect.objectContaining({
        id: structured.linkId,
        fileId: file.id,
        mimeType: "image/png",
        createdByUserId: userId,
        agentId: context.agent.id,
        conversationId,
        revokedAt: null,
      }),
    ]);

    await vi.waitFor(async () => {
      const audit = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "publicFileLink",
        limit: 10,
        offset: 0,
      });
      expect(audit.data).toEqual([
        expect.objectContaining({
          action: "publicFileLink.created",
          resourceId: structured.linkId,
          actorId: userId,
        }),
      ]);
      // The token is the link's whole credential; it never reaches the log.
      expect(JSON.stringify(audit.data[0].after)).not.toContain(
        structured.url.split("/")[4],
      );
      expect(audit.data[0].after).toMatchObject({ fileId: file.id });
    });
  });

  test("does not publish a file from another conversation", async () => {
    await enableSharing();
    const otherConversation = await ConversationModel.create({
      userId,
      organizationId,
      agentId: context.agent.id,
      title: "Other chat",
    });
    const foreign = await fileStore.put({
      organizationId,
      userId,
      projectId: null,
      conversationId: otherConversation.id,
      filename: "private.png",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
      data: PNG,
    });

    const result = await executeArchestraTool(
      SHARE,
      { fileId: foreign.id },
      context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No persistent file");
  });

  test("shares a sandbox path, retrying under a new name when the name is taken", async () => {
    await enableSharing();
    // The Dagger runtime is the process boundary: stand in for the export.
    const exportArtifact = vi
      .spyOn(skillSandboxRuntimeService, "exportArtifact")
      .mockRejectedValueOnce(new FileNameExistsError("image.png"))
      .mockImplementationOnce(async (params) => {
        const file = await putFile(params.filename ?? "image.png", PNG);
        return {
          artifactId: file.id,
          sandboxId: asSandboxId(params.sandboxId),
          path: params.path,
          mimeType: "image/png",
          sizeBytes: PNG.byteLength,
          stagingNotices: [],
          overwritten: false,
        };
      });

    const result = await executeArchestraTool(
      SHARE,
      { path: "/home/sandbox/attachments/image.png" },
      context,
    );

    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    expect(exportArtifact).toHaveBeenCalledTimes(2);
    expect(exportArtifact.mock.calls[0][0]).toMatchObject({ overwrite: false });
    expect(exportArtifact.mock.calls[1][0].filename).toMatch(
      /^image-[0-9a-f]{6}\.png$/,
    );
    expect((result.structuredContent as { filename: string }).filename).toBe(
      exportArtifact.mock.calls[1][0].filename,
    );
  });
});
