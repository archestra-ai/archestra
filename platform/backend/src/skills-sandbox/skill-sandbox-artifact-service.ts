import { SkillSandboxFileModel } from "@/models";
import type { SandboxFileListItem } from "@/types";
import { getSandboxFileStorage } from "./file-storage";

/**
 * Read-only listing of a user's sandbox artifacts for the X-Files surfaces.
 * Row enumeration stays in the model; the storage router decides what a listing
 * means per backend (db = the rows; filesystem = the on-disk directory).
 */
class SkillSandboxArtifactService {
  /** Surface A: artifacts produced in one conversation (all downloadable). */
  async listForConversation(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
  }): Promise<SandboxFileListItem[]> {
    const rows = await SkillSandboxFileModel.listUserArtifacts(params);
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      downloadable: true,
      folder: row.folderName,
    }));
  }

  /** Surface B: all of the user's files; backend hidden behind the router. */
  async listAllForUser(params: {
    organizationId: string;
    userId: string;
  }): Promise<SandboxFileListItem[]> {
    const rows = await SkillSandboxFileModel.listUserArtifacts(params);
    return getSandboxFileStorage().listUserFiles({
      userId: params.userId,
      rows,
    });
  }
}

export const skillSandboxArtifactService = new SkillSandboxArtifactService();
