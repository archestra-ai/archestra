import {
  EDITABLE_TEXT_FILE_MAX_BYTES,
  isEditableTextFile,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "@archestra/shared";
import config from "@/config";
import {
  FileModel,
  FileNameExistsError,
  ProjectModel,
  ProjectShareModel,
  UserModel,
} from "@/models";
import type {
  PersistedFile,
  SandboxArtifactRow,
  SandboxFileListItem,
} from "@/types";
import { UnsafePathError } from "./file-path";
import { deleteRowBytes, getObjectStore, readRowBytes } from "./file-storage";
import { mimeFromExtension, resolveArtifactMime } from "./mime-sniff";
import {
  FileBytesMissingError,
  FilePathConflictError,
  type OwnerScope,
} from "./object-store";
import { SkillSandboxError } from "./types";

/** MIME type the project instructions file is stored as. */
const INSTRUCTIONS_MIME_TYPE = "text/markdown";

/**
 * A delete targeted the project's instructions file (`instructions.md`). The
 * instructions file is an ordinary, available project file in every other
 * respect, but it cannot be deleted through the generic file surface — the way
 * to remove its guidance is to save empty content. Extends
 * {@link SkillSandboxError} so the sandbox tool handlers surface it as a clean,
 * model-facing message.
 */
export class FileNotDeletableError extends SkillSandboxError {
  constructor(filename: string) {
    super(
      `"${filename}" is the project's instructions file and can't be deleted. ` +
        `Clear its contents from the project's Instructions panel instead.`,
    );
    this.name = "FileNotDeletableError";
  }
}

/** Which files a `search` lists — a single owner scope. */
type FileSearchScope =
  | { kind: "conversation"; conversationId: string }
  | { kind: "project"; projectId: string; projectName: string | null };

/**
 * The scope a `my_file` resolution (by id or filename) is confined to: the
 * current conversation for a no-project chat, or the project for a project chat.
 */
type MyFileScope =
  | { kind: "conversation"; conversationId: string }
  | { kind: "project"; projectId: string };

/** The owner half of an untracked-object ref (ids only; ACL is checked from it). */
type RefScope =
  | { kind: "user"; userId: string }
  | { kind: "project"; projectId: string };

/** A file resolved for read: bytes + display metadata. `id` is null for untracked. */
type ResolvedFile = {
  id: string | null;
  filename: string;
  mimeType: string;
  data: Buffer;
};

type ResolvedMyFile = {
  /** The backing row id, for recording a conversation file touch; null for an
   * untracked (hand-placed) object that has no `files` row. */
  fileId: string | null;
  data: Buffer;
  mimeType: string;
  originalName: string;
};
export type MyFileResolutionError = {
  error: "not_found" | "ambiguous" | "missing_bytes" | "outside_project";
};

/**
 * The single entry point for persistent "My Files" access: `put`/`get`/`delete`
 * for bytes, `search` for an owner scope (personal or project), and `list` for a
 * conversation. When an external object store is configured, `search`/`get`/
 * `delete` also cover objects placed in it by hand (no DB row), addressed by an
 * `obj_` ref whose access is derived from its scope. Rows go through `FileModel`;
 * bytes through the provider-agnostic object-store seam. Consumers call this —
 * never `FileModel` or a store directly.
 */
class FileStore {
  /**
   * Persist bytes then insert the row, rolling the bytes back if the insert
   * fails. A duplicate name in scope — from the partial unique index or the
   * store's exclusive write — surfaces as {@link FileNameExistsError}.
   */
  async put(params: {
    organizationId: string;
    userId: string;
    projectId: string | null;
    conversationId: string | null;
    sandboxId?: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    data: Buffer;
  }): Promise<PersistedFile> {
    const store = getObjectStore();
    let storageProvider: PersistedFile["storageProvider"] = "db";
    let objectKey: string | null = null;
    let dbData: Buffer | null = params.data;
    if (store) {
      const scope = await this.resolveScope(params);
      try {
        const { key } = await store.write({
          scope,
          name: params.filename,
          data: params.data,
        });
        storageProvider = config.fileStorage.provider;
        objectKey = key;
        dbData = null;
      } catch (error) {
        if (error instanceof FilePathConflictError) {
          throw new FileNameExistsError(params.filename);
        }
        throw error;
      }
    }
    try {
      return await FileModel.insertRow({
        organizationId: params.organizationId,
        userId: params.userId,
        projectId: params.projectId,
        conversationId: params.conversationId,
        sandboxId: params.sandboxId ?? null,
        filename: params.filename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        storageProvider,
        data: dbData,
        objectKey,
      });
    } catch (error) {
      await deleteRowBytes({ provider: storageProvider, objectKey }).catch(
        () => {},
      );
      throw error;
    }
  }

  /**
   * Fetch a file the caller may access plus its bytes. `ref` is a UUID (a row) or
   * an `obj_` ref (an untracked object, access derived from its scope). Returns
   * null for "not found" AND "not yours" alike; throws
   * {@link FileBytesMissingError} when the bytes are gone.
   */
  async get(params: {
    ref: string;
    organizationId: string;
    userId: string;
  }): Promise<ResolvedFile | null> {
    const parsed = parseObjectRef(params.ref);
    if (parsed) {
      const store = getObjectStore();
      if (!store) return null;
      if (!(await this.canAccessScope(parsed.scope, params))) return null;
      return this.readObjectResolved(parsed, store);
    }
    const file = await this.authorizedFile(params);
    return file ? this.rowToResolved(file) : null;
  }

  /**
   * Read-only bytes for a `project:admin` overseeing a foreign project: resolves
   * only PROJECT-scoped files/objects (never personal ones) in the org, WITHOUT
   * the owner/share check. The caller (artifact route) must have already
   * confirmed `project:admin`. Distinct from {@link get}/{@link delete} so the
   * admin allowance can never reach a write/delete path.
   */
  async getProjectScopedForAdmin(params: {
    ref: string;
    organizationId: string;
  }): Promise<ResolvedFile | null> {
    const parsed = parseObjectRef(params.ref);
    if (parsed) {
      if (parsed.scope.kind !== "project") return null;
      const store = getObjectStore();
      if (!store) return null;
      if (!(await this.projectInOrg(parsed.scope.projectId, params))) {
        return null;
      }
      return this.readObjectResolved(parsed, store);
    }
    if (!UUID_RE.test(params.ref)) return null;
    const file = await FileModel.findById(params.ref);
    if (!file || file.organizationId !== params.organizationId) return null;
    if (!file.projectId) return null; // never expose personal files
    if (!(await this.projectInOrg(file.projectId, params))) return null;
    return this.rowToResolved(file);
  }

  /**
   * Delete a PROJECT-scoped file/object for a confirmed `project:admin`, without
   * the owner/share check — oversight delete of a foreign project's files. Never
   * touches personal (no-project) files. The route MUST verify `project:admin`
   * before calling this; `delete` stays the share/owner path for everyone else.
   */
  async deleteProjectScopedForAdmin(params: {
    ref: string;
    organizationId: string;
  }): Promise<boolean> {
    const parsed = parseObjectRef(params.ref);
    if (parsed) {
      if (parsed.scope.kind !== "project") return false;
      const store = getObjectStore();
      if (!store) return false;
      if (!(await this.projectInOrg(parsed.scope.projectId, params))) {
        return false;
      }
      // The instructions file is never deletable — not even via admin oversight.
      if (keyName(parsed.key) === PROJECT_INSTRUCTIONS_FILENAME) {
        throw new FileNotDeletableError(PROJECT_INSTRUCTIONS_FILENAME);
      }
      // Bind key→scope so a crafted ref can't delete a sibling folder's object.
      if (!(await this.objectRefOwned(parsed, store))) return false;
      await store.remove(parsed.key).catch(() => {});
      return true;
    }
    if (!UUID_RE.test(params.ref)) return false;
    const file = await FileModel.findById(params.ref);
    if (!file || file.organizationId !== params.organizationId) return false;
    if (!file.projectId) return false; // never delete personal files
    if (!(await this.projectInOrg(file.projectId, params))) return false;
    // The instructions file is never deletable — not even via admin oversight.
    if (file.filename === PROJECT_INSTRUCTIONS_FILENAME) {
      throw new FileNotDeletableError(file.filename);
    }
    await FileModel.deleteById(file.id);
    await deleteRowBytes({
      provider: file.storageProvider,
      objectKey: file.objectKey,
    }).catch(() => {});
    return true;
  }

  /** Delete a file (row first, then its bytes) the caller may access. */
  async delete(params: {
    ref: string;
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    const parsed = parseObjectRef(params.ref);
    if (parsed) {
      const store = getObjectStore();
      if (!store) return false;
      if (!(await this.canAccessScope(parsed.scope, params))) return false;
      // The instructions file is never deletable — including via an object ref
      // that addresses its bytes directly. Without this, deleting through the
      // object path would orphan the row (bytes gone, row left unreadable),
      // bypassing the row-level guard below.
      if (
        parsed.scope.kind === "project" &&
        keyName(parsed.key) === PROJECT_INSTRUCTIONS_FILENAME
      ) {
        throw new FileNotDeletableError(PROJECT_INSTRUCTIONS_FILENAME);
      }
      // Same key→scope binding as `get`: a crafted ref carrying the caller's own
      // scope but a sibling folder's key must NOT delete another scope's object.
      if (!(await this.objectRefOwned(parsed, store))) return false;
      await store.remove(parsed.key).catch(() => {});
      return true;
    }
    const file = await this.authorizedFile(params);
    if (!file) return false;
    // The project instructions file is available like any other file, but it is
    // never deletable — emptying it is the way to remove its guidance.
    if (file.projectId && file.filename === PROJECT_INSTRUCTIONS_FILENAME) {
      throw new FileNotDeletableError(file.filename);
    }
    await FileModel.deleteById(file.id);
    await deleteRowBytes({
      provider: file.storageProvider,
      objectKey: file.objectKey,
    }).catch(() => {});
    return true;
  }

  /**
   * Delete the stored bytes of every file in a project. Deleting the project row
   * cascade-deletes the `files` rows, but external bytes live outside Postgres,
   * so the caller must purge them around the delete. Inline (`db`) rows are a
   * no-op. Best-effort per file.
   */
  async purgeProjectBytes(params: {
    organizationId: string;
    projectId: string;
  }): Promise<void> {
    const rows = await FileModel.listByProject(params);
    await Promise.all(
      rows.map((row) =>
        deleteRowBytes({
          provider: row.storageProvider,
          objectKey: row.objectKey,
        }).catch(() => {}),
      ),
    );
  }

  /**
   * Delete a conversation's no-project files — both rows and external bytes —
   * when the conversation is deleted. No-project files belong to their
   * conversation, so they must not outlive it as unreachable orphans (the
   * `conversation_id` FK is `SET NULL`, so there is no row cascade; project
   * files, which outlive the conversation, are excluded). Must run BEFORE the
   * conversation row is deleted, while the files still carry its id. Best-effort
   * per file's bytes. Inline (`db`) rows just drop with the row.
   */
  async purgeConversationFiles(params: {
    organizationId: string;
    conversationId: string;
  }): Promise<void> {
    const rows = await FileModel.listNoProjectFilesForConversation(params);
    await Promise.all(
      rows.map(async (row) => {
        await FileModel.deleteById(row.id);
        await deleteRowBytes({
          provider: row.storageProvider,
          objectKey: row.objectKey,
        }).catch(() => {});
      }),
    );
  }

  /**
   * List one owner scope (a no-project conversation or a project), optionally
   * filtered by name. For a project scope with an object store configured, DB
   * rows are merged with objects present in the store but not in the table
   * (placed by hand), deduped by key; no-project scopes have no such objects.
   */
  async search(params: {
    organizationId: string;
    userId: string;
    scope: FileSearchScope;
    query?: string;
  }): Promise<SandboxFileListItem[]> {
    const { scope } = params;
    const rows =
      scope.kind === "project"
        ? await FileModel.listByProject({
            organizationId: params.organizationId,
            projectId: scope.projectId,
          })
        : await FileModel.listNoProjectByConversation({
            organizationId: params.organizationId,
            userId: params.userId,
            conversationId: scope.conversationId,
          });
    const projectName = scope.kind === "project" ? scope.projectName : null;
    const projectId = scope.kind === "project" ? scope.projectId : null;
    const query = params.query?.toLowerCase() ?? null;
    const items = rows
      .filter((r) => !query || r.filename.toLowerCase().includes(query))
      .map((r) => toListItem(r, projectName));

    // Hand-placed (rowless) objects are only surfaced for project scopes; the
    // personal/no-project untracked path was dropped when no-project files
    // became conversation-scoped (it would otherwise span conversations).
    const store = getObjectStore();
    if (store && scope.kind === "project") {
      const ownerScope = await this.projectScope(scope.projectId);
      if (ownerScope) {
        const refScope: RefScope = {
          kind: "project",
          projectId: scope.projectId,
        };
        const known = new Set<string>();
        for (const r of rows) if (r.objectKey) known.add(r.objectKey);
        for (const obj of await store.enumerate(ownerScope)) {
          if (known.has(obj.key)) continue;
          if (query && !obj.name.toLowerCase().includes(query)) continue;
          items.push({
            id: null,
            downloadRef: encodeObjectRef(refScope, obj.key),
            filename: obj.name,
            mimeType: mimeFromExtension(obj.name),
            sizeBytes: obj.size,
            createdAt: obj.modifiedAt,
            downloadable: true,
            projectId,
            projectName,
          });
        }
      }
    }
    return items;
  }

  /**
   * List the files of one conversation. `authorUserId` set → only that author's
   * files (newest first); omitted → every author's files (oldest first, the chat
   * Files panel's "generated" section). DB-only: a conversation is a row concept.
   */
  async list(params: {
    organizationId: string;
    conversationId: string;
    authorUserId?: string;
  }): Promise<SandboxFileListItem[]> {
    if (params.authorUserId) {
      const rows = await FileModel.listByConversation({
        organizationId: params.organizationId,
        userId: params.authorUserId,
        conversationId: params.conversationId,
      });
      return rows.map((r) => toListItem(r, null));
    }
    const meta = await FileModel.listMetadataByConversationId({
      conversationId: params.conversationId,
      organizationId: params.organizationId,
    });
    return meta.map((m) => ({
      id: m.id,
      downloadRef: m.id,
      filename: m.filename,
      mimeType: m.mimeType,
      sizeBytes: m.sizeBytes,
      createdAt: m.createdAt,
      downloadable: true,
      projectId: null,
      projectName: null,
    }));
  }

  /**
   * Resolve a `my_file` upload source (by row id, or by `filename` within the
   * chat's scope — the current conversation for a no-project chat, the project
   * for a project chat) to its bytes. A duplicated filename is reported as
   * ambiguous rather than picking one silently. For a project scope a
   * hand-placed object (no row) is matched by ref/filename too; no-project
   * (conversation) scopes have no hand-placed objects.
   */
  async resolveMyFileSource(params: {
    organizationId: string;
    userId: string;
    id?: string;
    filename?: string;
    scope: MyFileScope;
  }): Promise<ResolvedMyFile | MyFileResolutionError> {
    // A stable `obj_` ref (from search_files) addresses a hand-placed object
    // directly — only project scopes surface those.
    if (params.id && parseObjectRef(params.id)) {
      if (params.scope.kind !== "project") return { error: "not_found" };
      return this.resolveUntrackedByRef({
        projectId: params.scope.projectId,
        ref: params.id,
      });
    }
    const row = await this.findMyFileRow(params);
    if (row === null) {
      // no matching row — for a project, try a hand-placed object by filename.
      if (params.scope.kind !== "project") return { error: "not_found" };
      return this.resolveUntrackedByName({
        projectId: params.scope.projectId,
        filename: params.filename ?? "",
      });
    }
    if ("error" in row) return row;
    return this.readBytes(row);
  }

  /**
   * Resolve a `my_file` ref (id, or filename within scope) to its row, for
   * edit/delete. Same resolution + ACL as {@link resolveMyFileSource}, but
   * returns the row and never falls back to a rowless (hand-placed) object.
   */
  async resolveMyFileRef(params: {
    organizationId: string;
    userId: string;
    id?: string;
    filename?: string;
    scope: MyFileScope;
  }): Promise<PersistedFile | MyFileResolutionError> {
    const row = await this.findMyFileRow(params);
    if (row === null) return { error: "not_found" };
    return row;
  }

  /**
   * Resolve a headless (no-project, no-conversation) file by name, for a
   * headless `save_file` overwrite — there is no conversation/project scope to
   * resolve within, so this targets the orphan bucket directly.
   */
  async resolveOrphanRef(params: {
    organizationId: string;
    userId: string;
    filename: string;
  }): Promise<PersistedFile | MyFileResolutionError> {
    const row = await FileModel.findOrphanByName(params);
    return row ?? { error: "not_found" };
  }

  /**
   * Replace a file's bytes in place (edit_file), keeping its id and filename.
   * Re-stores via the active backend and updates the row; drops the old external
   * bytes if they lived at a different key. Returns null if the row vanished.
   */
  async update(params: {
    file: PersistedFile;
    mimeType: string;
    sizeBytes: number;
    data: Buffer;
  }): Promise<PersistedFile | null> {
    const { file } = params;
    const store = getObjectStore();
    if (store) {
      const scope = await this.resolveScope({
        userId: file.userId,
        projectId: file.projectId,
        conversationId: file.conversationId,
      });
      const { key } = await store.write({
        scope,
        name: file.filename,
        data: params.data,
        overwrite: true,
      });
      const updated = await FileModel.updateContent({
        id: file.id,
        organizationId: file.organizationId,
        storageProvider: config.fileStorage.provider,
        objectKey: key,
        data: null,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
      });
      if (!updated) return null;
      // drop old external bytes only if they lived at a different key/provider.
      if (
        file.storageProvider !== "db" &&
        file.objectKey &&
        (file.objectKey !== key ||
          file.storageProvider !== config.fileStorage.provider)
      ) {
        await deleteRowBytes({
          provider: file.storageProvider,
          objectKey: file.objectKey,
        }).catch(() => {});
      }
      return updated;
    }
    // inline db: bytes live in the row.
    return FileModel.updateContent({
      id: file.id,
      organizationId: file.organizationId,
      storageProvider: "db",
      objectKey: null,
      data: params.data,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
    });
  }

  /**
   * Overwrite a row-backed text file's content from the browser editor.
   * Authorizes with the same author-or-project-access rule as {@link get} and
   * {@link delete} (via {@link authorizedFile}), then replaces the bytes in place
   * through {@link update}, preserving the filename and stored MIME (a text edit
   * never changes type). Restricted to Markdown/plain-text rows; the project
   * instructions file keeps its own owner/admin-only route and is refused here so
   * the generic project-access rule can't rewrite project guidance. Returns the
   * updated row, or a discriminated error the route maps to a status code.
   *
   * Oversight `project:admin` never reaches a write here: this uses
   * `authorizedFile`, not the `getProjectScopedForAdmin` fallback, so an
   * overseeing admin who is not the author / not a project member gets
   * `not_found`.
   */
  async updateTextFileContent(params: {
    ref: string;
    organizationId: string;
    userId: string;
    content: string;
  }): Promise<
    | PersistedFile
    | { error: "not_found" | "reserved" | "not_editable" | "too_large" }
  > {
    // Row-backed files only: `authorizedFile` returns null for a non-UUID/`obj_`
    // ref (a rowless object has no row to update) and for "not yours".
    const file = await this.authorizedFile(params);
    if (!file) return { error: "not_found" };
    // The instructions file is editable only through its own owner/admin-gated
    // route (its content is injected into every chat's system prompt); refuse it
    // here so the generic project-access rule can't rewrite project guidance.
    if (file.projectId && file.filename === PROJECT_INSTRUCTIONS_FILENAME) {
      return { error: "reserved" };
    }
    if (
      !isEditableTextFile({ filename: file.filename, mimeType: file.mimeType })
    ) {
      return { error: "not_editable" };
    }
    const data = Buffer.from(params.content, "utf8");
    if (data.byteLength > EDITABLE_TEXT_FILE_MAX_BYTES) {
      return { error: "too_large" };
    }
    // Preserve the stored MIME — a content edit of a text file never changes its
    // type (mirrors the edit_file tool).
    const updated = await this.update({
      file,
      mimeType: file.mimeType,
      sizeBytes: data.byteLength,
      data,
    });
    return updated ?? { error: "not_found" };
  }

  /**
   * Read a project's instructions file content, or null when it has never been
   * saved. Resolves the backing row by name only — a same-named hand-placed
   * object never stands in for the (possibly empty) real file, so "no row" is the
   * single source of the virtual/empty state.
   */
  async readProjectInstructions(params: {
    organizationId: string;
    projectId: string;
  }): Promise<string | null> {
    const row = await FileModel.findByProjectAndName({
      organizationId: params.organizationId,
      projectId: params.projectId,
      filename: PROJECT_INSTRUCTIONS_FILENAME,
    });
    if (!row) return null;
    return (await readRowBytes(row)).toString("utf8");
  }

  /**
   * Create or replace a project's instructions file with `content` (empty is a
   * valid, kept file). Upserts the reserved name through the normal write path.
   */
  async writeProjectInstructions(params: {
    organizationId: string;
    userId: string;
    projectId: string;
    content: string;
  }): Promise<void> {
    const data = Buffer.from(params.content, "utf8");
    const existing = await FileModel.findByProjectAndName({
      organizationId: params.organizationId,
      projectId: params.projectId,
      filename: PROJECT_INSTRUCTIONS_FILENAME,
    });
    if (existing) {
      await this.update({
        file: existing,
        mimeType: INSTRUCTIONS_MIME_TYPE,
        sizeBytes: data.byteLength,
        data,
      });
      return;
    }
    await this.put({
      organizationId: params.organizationId,
      userId: params.userId,
      projectId: params.projectId,
      conversationId: null,
      sandboxId: null,
      filename: PROJECT_INSTRUCTIONS_FILENAME,
      mimeType: INSTRUCTIONS_MIME_TYPE,
      sizeBytes: data.byteLength,
      data,
    });
  }

  // === internal ===

  /**
   * Resolve a `my_file` ref to its row: by id (org + scope checked), or by exact
   * filename within the scope. Returns the row, a definitive error (ambiguous /
   * outside_project / not_found-by-id), or null when no row matches a filename
   * (the caller may then try a hand-placed object).
   */
  private async findMyFileRow(params: {
    organizationId: string;
    userId: string;
    id?: string;
    filename?: string;
    scope: MyFileScope;
  }): Promise<PersistedFile | MyFileResolutionError | null> {
    const { scope } = params;
    if (params.id) {
      // a non-UUID id is never a row id (and would error the uuid column query).
      if (!UUID_RE.test(params.id)) return { error: "not_found" };
      const file = await FileModel.findById(params.id);
      if (!file || file.organizationId !== params.organizationId) {
        return { error: "not_found" };
      }
      if (scope.kind === "project") {
        if (file.projectId !== scope.projectId)
          return { error: "outside_project" };
      } else if (
        file.projectId != null ||
        file.conversationId !== scope.conversationId ||
        file.userId !== params.userId
      ) {
        // a no-project file authored by this user in this conversation only.
        return { error: "not_found" };
      }
      return file;
    }
    const filename = params.filename ?? "";
    const candidates =
      scope.kind === "project"
        ? await FileModel.listByProject({
            organizationId: params.organizationId,
            projectId: scope.projectId,
          })
        : await FileModel.listNoProjectByConversation({
            organizationId: params.organizationId,
            userId: params.userId,
            conversationId: scope.conversationId,
          });
    const matches = candidates.filter((f) => f.filename === filename);
    if (matches.length > 1) return { error: "ambiguous" };
    if (matches.length === 1) {
      const file = await FileModel.findById(matches[0].id);
      return file ?? { error: "not_found" };
    }
    return null;
  }

  /**
   * An untracked object addressed by its stable `obj_` ref, confined to the
   * caller's chat scope: the owner scope is derived from the chat (NOT the ref's
   * embedded scope), and the key must belong to it (verified by enumeration). So
   * a ref carrying a foreign or crafted key resolves to not-found, never a
   * cross-scope read.
   */
  private async resolveUntrackedByRef(params: {
    projectId: string;
    ref: string;
  }): Promise<ResolvedMyFile | MyFileResolutionError> {
    const parsed = parseObjectRef(params.ref);
    if (!parsed) return { error: "not_found" };
    const store = getObjectStore();
    if (!store) return { error: "not_found" };
    const ownerScope = await this.projectScope(params.projectId);
    if (!ownerScope) return { error: "not_found" };
    if (
      !(await store.enumerate(ownerScope)).some((o) => o.key === parsed.key)
    ) {
      return { error: "not_found" };
    }
    try {
      const data = await store.read(parsed.key);
      const name = keyName(parsed.key);
      return {
        fileId: null,
        data,
        mimeType: resolveArtifactMime({
          buffer: data,
          claimed: mimeFromExtension(name),
        }),
        originalName: name,
      };
    } catch (error) {
      if (error instanceof FileBytesMissingError)
        return { error: "missing_bytes" };
      if (error instanceof UnsafePathError) return { error: "not_found" };
      throw error;
    }
  }

  /** An untracked object matched by filename within a project upload scope. */
  private async resolveUntrackedByName(params: {
    projectId: string;
    filename: string;
  }): Promise<ResolvedMyFile | MyFileResolutionError> {
    const store = getObjectStore();
    if (!store) return { error: "not_found" };
    const ownerScope = await this.projectScope(params.projectId);
    if (!ownerScope) return { error: "not_found" };
    const match = (await store.enumerate(ownerScope)).find(
      (o) => o.name === params.filename,
    );
    if (!match) return { error: "not_found" };
    try {
      const data = await store.read(match.key);
      return {
        fileId: null, // untracked object — no row to touch
        data,
        mimeType: resolveArtifactMime({
          buffer: data,
          claimed: mimeFromExtension(params.filename),
        }),
        originalName: params.filename,
      };
    } catch (error) {
      if (error instanceof FileBytesMissingError)
        return { error: "missing_bytes" };
      if (error instanceof UnsafePathError) return { error: "not_found" };
      throw error;
    }
  }

  /**
   * Bind an `obj_` ref's opaque key to the scope it claims: the key must be an
   * object that scope actually owns (verified by enumeration), so a ref carrying
   * the caller's own scope but a sibling folder's key (e.g. `other@x.com/secret`,
   * no traversal) resolves to "not owned" rather than reaching another tenant's
   * file under the shared root. Enumeration is provider-agnostic and skips
   * symlinks. Only project refs are minted today (personal untracked objects were
   * dropped with conversation scoping); the `user` scope arm is retained as
   * defense-in-depth for a hand-crafted ref and enumerates the flat `<email>`
   * folder.
   */
  private async objectRefOwned(
    parsed: { scope: RefScope; key: string },
    store: NonNullable<ReturnType<typeof getObjectStore>>,
  ): Promise<boolean> {
    const ownerScope =
      parsed.scope.kind === "user"
        ? await this.userScope(parsed.scope.userId)
        : await this.projectScope(parsed.scope.projectId);
    if (!ownerScope) return false;
    return (await store.enumerate(ownerScope)).some(
      (o) => o.key === parsed.key,
    );
  }

  /** Can the caller reach an untracked object's owner scope? */
  private async canAccessScope(
    scope: RefScope,
    caller: { organizationId: string; userId: string },
  ): Promise<boolean> {
    if (scope.kind === "user") return scope.userId === caller.userId;
    const project = await ProjectModel.findById(scope.projectId);
    if (!project || project.organizationId !== caller.organizationId) {
      return false;
    }
    return ProjectShareModel.userCanAccessProject({
      project,
      userId: caller.userId,
      organizationId: caller.organizationId,
    });
  }

  /**
   * Authorize a caller for a row and return it, else null. Read and delete share
   * the rule: the author for a personal file, or anyone with access to the owning
   * project for a project file.
   */
  private async authorizedFile(params: {
    ref: string;
    organizationId: string;
    userId: string;
  }): Promise<PersistedFile | null> {
    // a non-UUID ref is never a row id (and would error the uuid column query).
    if (!UUID_RE.test(params.ref)) return null;
    const file = await FileModel.findById(params.ref);
    if (!file || file.organizationId !== params.organizationId) return null;
    if (file.projectId) {
      const project = await ProjectModel.findById(file.projectId);
      if (!project) return null;
      const canAccess = await ProjectShareModel.userCanAccessProject({
        project,
        userId: params.userId,
        organizationId: params.organizationId,
      });
      return canAccess ? file : null;
    }
    return file.userId === params.userId ? file : null;
  }

  /** Is this project in the caller's org? (admin-oversight read gate) */
  private async projectInOrg(
    projectId: string,
    ctx: { organizationId: string },
  ): Promise<boolean> {
    const project = await ProjectModel.findById(projectId);
    return !!project && project.organizationId === ctx.organizationId;
  }

  /** Read + build a ResolvedFile for an untracked object (after authorization). */
  private async readObjectResolved(
    parsed: { scope: RefScope; key: string },
    store: NonNullable<ReturnType<typeof getObjectStore>>,
  ): Promise<ResolvedFile | null> {
    if (!(await this.objectRefOwned(parsed, store))) return null;
    let data: Buffer;
    try {
      data = await store.read(parsed.key);
    } catch (error) {
      // a path escaping the root reads as "not found", not a 500.
      if (error instanceof UnsafePathError) return null;
      throw error;
    }
    const name = keyName(parsed.key);
    return {
      id: null,
      filename: name,
      mimeType: resolveArtifactMime({
        buffer: data,
        claimed: mimeFromExtension(name),
      }),
      data,
    };
  }

  /** Build a ResolvedFile for a persisted row (after authorization). */
  private async rowToResolved(file: PersistedFile): Promise<ResolvedFile> {
    return {
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      data: await readRowBytes(file),
    };
  }

  /**
   * The owner scope a new file's bytes go under (only resolved for a store). A
   * no-project file is nested under its conversation (`<email>/<conversationId>`);
   * a headless write (no conversation) falls back to the flat `<email>` folder.
   */
  private async resolveScope(params: {
    userId: string;
    projectId: string | null;
    conversationId: string | null;
  }): Promise<OwnerScope> {
    if (params.projectId) {
      const scope = await this.projectScope(params.projectId);
      if (!scope) {
        throw new Error(`project ${params.projectId} not found for file write`);
      }
      return scope;
    }
    const scope = await this.userScope(params.userId, params.conversationId);
    if (!scope) throw new Error(`user ${params.userId} has no email`);
    return scope;
  }

  // the folder is the project's immutable slug, so a rename never moves files.
  private async projectScope(projectId: string): Promise<OwnerScope | null> {
    const project = await ProjectModel.findById(projectId);
    return project ? { kind: "project", projectId, label: project.slug } : null;
  }

  private async userScope(
    userId: string,
    conversationId: string | null = null,
  ): Promise<OwnerScope | null> {
    const email = await UserModel.getEmailById(userId);
    return email
      ? { kind: "user", userId, label: email, conversationId }
      : null;
  }

  private async readBytes(
    file: PersistedFile,
  ): Promise<ResolvedMyFile | MyFileResolutionError> {
    try {
      return {
        fileId: file.id,
        data: await readRowBytes(file),
        mimeType: file.mimeType,
        originalName: file.filename,
      };
    } catch (error) {
      if (error instanceof FileBytesMissingError)
        return { error: "missing_bytes" };
      throw error;
    }
  }
}

export const fileStore = new FileStore();

// === internal ===

/** Prefix marking an opaque object ref (`obj_…`) vs a row UUID. @public */
export const OBJECT_REF_PREFIX = "obj_";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toListItem(
  row: SandboxArtifactRow,
  projectName: string | null,
): SandboxFileListItem {
  return {
    id: row.id,
    downloadRef: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    downloadable: true,
    projectId: row.projectId,
    projectName,
  };
}

/** Opaque download handle for an untracked object: `obj_` + base64url({scope,key}). */
function encodeObjectRef(scope: RefScope, key: string): string {
  return (
    OBJECT_REF_PREFIX +
    Buffer.from(JSON.stringify({ s: scope, k: key }), "utf8").toString(
      "base64url",
    )
  );
}

/**
 * Decode + validate an object ref into its owner scope and opaque key. Returns
 * null for a non-`obj_` ref or any malformed payload; the key itself is validated
 * by the store on read. Callers treat null as "not an object ref".
 */
function parseObjectRef(ref: string): { scope: RefScope; key: string } | null {
  if (!ref.startsWith(OBJECT_REF_PREFIX)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(ref.slice(OBJECT_REF_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const { s, k } = decoded as { s?: unknown; k?: unknown };
  if (typeof k !== "string" || !k) return null;
  if (typeof s !== "object" || s === null) return null;
  const scope = s as { kind?: unknown; userId?: unknown; projectId?: unknown };
  if (scope.kind === "user" && typeof scope.userId === "string") {
    return { scope: { kind: "user", userId: scope.userId }, key: k };
  }
  if (scope.kind === "project" && typeof scope.projectId === "string") {
    return { scope: { kind: "project", projectId: scope.projectId }, key: k };
  }
  return null;
}

/** The basename of an object key (its display filename). */
function keyName(key: string): string {
  return key.split("/").pop() ?? key;
}
