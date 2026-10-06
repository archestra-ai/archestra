import { randomBytes } from "node:crypto";
import config from "@/config";
import { OrganizationModel, PublicFileLinkModel } from "@/models";
import { PUBLIC_FILES_PREFIX } from "@/routes/route-paths";
import { fileStore } from "@/skills-sandbox/file-store";
import type { PublicFileLink } from "@/types/public-file-link";
import {
  extensionForPublicFileMime,
  PUBLIC_FILE_ALLOWED_TYPES_LABEL,
  sniffPublicFileMime,
} from "./media-types";

/**
 * Public, login-free links to persistent files. The agent-facing half
 * (`share`) checks the organization switch, the media type and size, and mints
 * a link; the internet-facing half (`resolve`) turns a token back into bytes
 * for the `/public-files` route.
 *
 * A link points at the live file, so the route re-checks everything on every
 * request: the link must not be revoked, the organization's switch must still
 * be on, and the file's current bytes must still be an allowed media type.
 */
class PublicFileSharingService {
  /** Mint a public link for a file the caller has already been authorized to read. */
  async share(params: {
    organizationId: string;
    userId: string;
    agentId: string | null;
    conversationId: string | null;
    file: { id: string; filename: string; data: Buffer };
  }): Promise<
    | { link: PublicFileLink; url: string }
    | { error: "disabled" | "too_large" | "unsupported_type"; message: string }
  > {
    if (!(await this.isEnabled(params.organizationId))) {
      return {
        error: "disabled",
        message:
          "Public file sharing is turned off for this organization. An admin must enable “Allow agents to share files publicly” in the organization settings before files can be shared.",
      };
    }

    const { file } = params;
    const limit = config.skillsSandbox.artifactBytesLimit;
    if (file.data.byteLength > limit) {
      return {
        error: "too_large",
        message: `"${file.filename}" is too large to share publicly (${file.data.byteLength} bytes > ${limit} byte limit).`,
      };
    }

    const mimeType = sniffPublicFileMime(file.data);
    if (!mimeType) {
      return {
        error: "unsupported_type",
        message: `"${file.filename}" can't be shared publicly: only ${PUBLIC_FILE_ALLOWED_TYPES_LABEL} files can be shared.`,
      };
    }

    const link = await PublicFileLinkModel.create({
      organizationId: params.organizationId,
      token: randomBytes(TOKEN_BYTES).toString("base64url"),
      fileId: file.id,
      createdByUserId: params.userId,
      agentId: params.agentId,
      conversationId: params.conversationId,
      filename: file.filename,
      mimeType,
      sizeBytes: file.data.byteLength,
    });
    return { link, url: this.buildUrl(link) };
  }

  /**
   * Bytes to serve for a token, or null for anything that must 404: an
   * unknown or revoked token, an organization whose switch is off, a file
   * that is gone, or bytes that are no longer an allowed media type.
   */
  async resolve(
    token: string,
  ): Promise<{ filename: string; mimeType: string; data: Buffer } | null> {
    if (!TOKEN_RE.test(token)) return null;
    const link = await PublicFileLinkModel.findActiveByToken(token);
    if (!link) return null;
    if (!(await this.isEnabled(link.organizationId))) return null;

    const file = await fileStore.getForPublicLink({
      fileId: link.fileId,
      organizationId: link.organizationId,
    });
    if (!file) return null;
    const mimeType = sniffPublicFileMime(file.data);
    if (!mimeType) return null;
    return { filename: link.filename, mimeType, data: file.data };
  }

  /**
   * `<base>/public-files/<token>/<filename>`. The filename is cosmetic (the
   * token alone authorizes); it gets the media type's extension when it lacks
   * it, because some services judge a link by how its path ends.
   */
  buildUrl(link: { token: string; filename: string; mimeType: string }) {
    const extension = extensionForPublicFileMime(link.mimeType);
    let name = link.filename.split("/").pop() || "file";
    if (
      extension &&
      !name.toLowerCase().endsWith(`.${extension}`) &&
      !(extension === "jpg" && name.toLowerCase().endsWith(".jpeg"))
    ) {
      name = `${name}.${extension}`;
    }
    return `${config.publicFiles.baseUrl}${PUBLIC_FILES_PREFIX}/${link.token}/${encodeURIComponent(name)}`;
  }

  private async isEnabled(organizationId: string): Promise<boolean> {
    const organization = await OrganizationModel.getById(organizationId);
    return organization?.allowPublicFileSharing ?? false;
  }
}

export const publicFileSharing = new PublicFileSharingService();

// === internal ===

/** 24 random bytes = 192 bits, 32 URL-safe base64 characters. */
const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
