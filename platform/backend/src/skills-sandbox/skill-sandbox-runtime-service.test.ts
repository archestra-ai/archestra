import {
  ConversationAttachmentModel,
  SkillSandboxFileModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
} from "@/models";
import { afterEach, describe, expect, test, vi } from "@/test";
import { asSandboxId } from "@/types";
import {
  __internals,
  skillSandboxRuntimeService,
} from "./skill-sandbox-runtime-service";
import { SkillSandboxError } from "./types";

async function seedAttachment(params: {
  organizationId: string;
  conversationId: string;
  userId: string;
  name: string;
  data: Buffer;
}) {
  return ConversationAttachmentModel.create({
    organizationId: params.organizationId,
    conversationId: params.conversationId,
    uploadedByUserId: params.userId,
    originalName: params.name,
    mimeType: "application/octet-stream",
    fileSize: params.data.byteLength,
    contentHash: ConversationAttachmentModel.computeContentHash(params.data),
    fileData: params.data,
  });
}

function uploadPaths(
  log: Awaited<ReturnType<typeof SkillSandboxReplayEventModel.listBySandbox>>,
): string[] {
  return log.flatMap((e) => (e.kind === "upload" ? [e.upload.path] : []));
}

describe("skillSandboxRuntimeService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("is disabled when ARCHESTRA_AGENTS_SKILLS_ENABLED or ARCHESTRA_CODE_RUNTIME_ENABLED is unset", () => {
    expect(skillSandboxRuntimeService.isEnabled).toBe(false);
    expect(skillSandboxRuntimeService.isReady).toBe(false);
  });

  test("runCommand rejects with SkillSandboxError while disabled", async () => {
    await expect(
      skillSandboxRuntimeService.runCommand({
        sandboxId: asSandboxId(crypto.randomUUID()),
        caller: { userId: "u", organizationId: "o" },
        command: "echo hi",
      }),
    ).rejects.toBeInstanceOf(SkillSandboxError);
  });

  test("exportArtifact rejects with SkillSandboxError while disabled", async () => {
    await expect(
      skillSandboxRuntimeService.exportArtifact({
        sandboxId: asSandboxId(crypto.randomUUID()),
        caller: { userId: "u", organizationId: "o" },
        path: "out/report.txt",
      }),
    ).rejects.toBeInstanceOf(SkillSandboxError);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
  ])("runCommand rejects invalid timeoutSeconds=%s before initializing", async (timeoutSeconds) => {
    const enabled = await importEnabledService();

    await expect(
      enabled.runCommand({
        sandboxId: asSandboxId(crypto.randomUUID()),
        caller: { userId: "u", organizationId: "o" },
        command: "echo hi",
        timeoutSeconds,
      }),
    ).rejects.toThrow("timeoutSeconds must");
  });

  test("runCommand rejects empty commands", async () => {
    const enabled = await importEnabledService();

    await expect(
      enabled.runCommand({
        sandboxId: asSandboxId(crypto.randomUUID()),
        caller: { userId: "u", organizationId: "o" },
        command: "   ",
      }),
    ).rejects.toThrow("command must be a non-empty string");
  });

  test("runCommand rejects NUL bytes in command or cwd before executing", async () => {
    const enabled = await importEnabledService();
    const NUL = String.fromCharCode(0);

    await expect(
      enabled.runCommand({
        sandboxId: asSandboxId(crypto.randomUUID()),
        caller: { userId: "u", organizationId: "o" },
        command: `echo${NUL} hi`,
      }),
    ).rejects.toThrow("must not contain NUL bytes");

    await expect(
      enabled.runCommand({
        sandboxId: asSandboxId(crypto.randomUUID()),
        caller: { userId: "u", organizationId: "o" },
        command: "echo hi",
        cwd: `/home/sandbox${NUL}`,
      }),
    ).rejects.toThrow("must not contain NUL bytes");
  });

  test("queue guard rejects exactly the calls beyond maxSandboxQueueLength", async () => {
    const enabled = await importEnabledService();
    const { SKILL_SANDBOX_LIMITS } = await import("./types");

    const sandboxId = asSandboxId(crypto.randomUUID());
    // all N+1 calls are created synchronously, so the first N take queue slots
    // (and later fail — no real Dagger engine) while only the last one trips
    // the guard before any await.
    const results = await Promise.allSettled(
      Array.from(
        { length: SKILL_SANDBOX_LIMITS.maxSandboxQueueLength + 1 },
        () =>
          enabled.runCommand({
            sandboxId,
            caller: { userId: "u", organizationId: "o" },
            command: "echo hi",
          }),
      ),
    );
    // use message check rather than instanceof: vi.resetModules creates a fresh
    // class so instanceof against the top-level import would always be false.
    const queueErrors = results.filter(
      (r) =>
        r.status === "rejected" &&
        (r.reason as Error)?.message?.includes("too many requests"),
    );
    expect(queueErrors).toHaveLength(1);
  });

  test("queue guard resets after the saturated queue drains", async () => {
    const enabled = await importEnabledService();
    const { SKILL_SANDBOX_LIMITS } = await import("./types");

    const sandboxId = asSandboxId(crypto.randomUUID());
    await Promise.allSettled(
      Array.from(
        { length: SKILL_SANDBOX_LIMITS.maxSandboxQueueLength + 1 },
        () =>
          enabled.runCommand({
            sandboxId,
            caller: { userId: "u", organizationId: "o" },
            command: "echo hi",
          }),
      ),
    );

    // the queue fully drained, so the next call must reach the sandbox load
    // (and fail there — no sandbox row) instead of tripping the queue guard.
    const [after] = await Promise.allSettled([
      enabled.runCommand({
        sandboxId,
        caller: { userId: "u", organizationId: "o" },
        command: "echo hi",
      }),
    ]);
    expect(after.status).toBe("rejected");
    expect((after as PromiseRejectedResult).reason?.message).not.toContain(
      "too many requests",
    );
  });

  test("a call enqueued right as the previous one settles is not lost", async () => {
    const enabled = await importEnabledService();

    const sandboxId = asSandboxId(crypto.randomUUID());
    const run = () =>
      enabled.runCommand({
        sandboxId,
        caller: { userId: "u", organizationId: "o" },
        command: "echo hi",
      });

    // sequential reuse of the same sandbox right after the previous call
    // settled: guards against cleanup schemes (e.g. tail-attached deletion)
    // that could evict or reject a freshly enqueued call.
    const [first] = await Promise.allSettled([run()]);
    const [second] = await Promise.allSettled([run()]);
    for (const result of [first, second]) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason?.message).not.toContain(
        "too many requests",
      );
    }
  });
});

/**
 * the queue tests need the service compiled with the sandbox feature on; each
 * gets a fresh module registry so the singleton's queue state starts empty.
 */
async function importEnabledService() {
  vi.resetModules();
  vi.stubEnv("ARCHESTRA_AGENTS_SKILLS_ENABLED", "true");
  vi.stubEnv("ARCHESTRA_CODE_RUNTIME_ENABLED", "true");
  vi.stubEnv(
    "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST",
    "tcp://dagger-runtime.dagger.svc.cluster.local:1234",
  );
  const { skillSandboxRuntimeService: enabled } = await import(
    "./skill-sandbox-runtime-service"
  );
  return enabled;
}

describe("__internals", () => {
  test("requirementsInstallCommands picks up root and nested requirements.txt in path order", () => {
    const commands = __internals.requirementsInstallCommands("alpha", [
      "tools/extract.py",
      "tools/requirements.txt",
      "requirements.txt",
      "references/notes.md",
    ]);
    expect(commands.map((c) => c.command)).toEqual([
      "uv add --project /home/sandbox --quiet -r '/skills/alpha/requirements.txt'",
      "uv add --project /home/sandbox --quiet -r '/skills/alpha/tools/requirements.txt'",
    ]);
    expect(commands.every((c) => c.cwd === "/home/sandbox")).toBe(true);
  });

  test("requirementsInstallCommands ignores files merely named like requirements", () => {
    expect(
      __internals.requirementsInstallCommands("alpha", [
        "docs/requirements.txt.md",
        "old-requirements.txt",
        "tools/requirements.md",
      ]),
    ).toEqual([]);
  });

  test("requirementsInstallCommands skips documentation under references/", () => {
    expect(
      __internals
        .requirementsInstallCommands("alpha", [
          "references/requirements.txt",
          "references/setup/requirements.txt",
          "./references/requirements.txt",
          "tools/requirements.txt",
        ])
        .map((c) => c.command),
    ).toEqual([
      "uv add --project /home/sandbox --quiet -r '/skills/alpha/tools/requirements.txt'",
    ]);
  });

  test("resolveArtifactPath joins relative paths against defaultCwd", () => {
    expect(
      __internals.resolveArtifactPath({
        path: "out/report.txt",
        defaultCwd: "/skills/alpha",
      }),
    ).toBe("/skills/alpha/out/report.txt");

    expect(
      __internals.resolveArtifactPath({
        path: "/skills/alpha/out/report.txt",
        defaultCwd: "/skills/alpha",
      }),
    ).toBe("/skills/alpha/out/report.txt");

    expect(
      __internals.resolveArtifactPath({
        path: "/home/sandbox/output.json",
        defaultCwd: "/skills/alpha",
      }),
    ).toBe("/home/sandbox/output.json");

    expect(
      __internals.resolveArtifactPath({
        path: "out/report.txt",
        defaultCwd: "/skills/alpha/",
      }),
    ).toBe("/skills/alpha/out/report.txt");
  });

  test("resolveArtifactPath rejects path traversal", () => {
    expect(() =>
      __internals.resolveArtifactPath({
        path: "../../etc/passwd",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("invalid artifact path");

    expect(() =>
      __internals.resolveArtifactPath({
        path: "/skills/alpha/../../../etc/passwd",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("invalid artifact path");
  });

  test("resolveArtifactPath rejects paths with null bytes", () => {
    expect(() =>
      __internals.resolveArtifactPath({
        path: "out/file\x00.txt",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("invalid artifact path");
  });

  test("resolveArtifactPath rejects absolute paths outside sandbox roots", () => {
    expect(() =>
      __internals.resolveArtifactPath({
        path: "/etc/passwd",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("artifact path must be under");

    expect(() =>
      __internals.resolveArtifactPath({
        path: "/tmp/file.txt",
        defaultCwd: "/skills/alpha",
      }),
    ).toThrow("artifact path must be under");
  });

  test("validateUploadPath rejects directory and sandbox-root targets", () => {
    // the resolved roots themselves are directories: persisting an upload to
    // one would replay-fail forever or shadow /skills and break skill mounts.
    for (const root of ["/skills", "/home/sandbox"]) {
      expect(() => __internals.validateUploadPath(root)).toThrow(
        "must be a file, not a directory",
      );
    }
    expect(() => __internals.validateUploadPath("/skills/")).toThrow(
      "must be a file, not a directory",
    );
    // a real file under a root is accepted.
    expect(() =>
      __internals.validateUploadPath("/skills/alpha/input.csv"),
    ).not.toThrow();
  });

  test("validateSkillMountFilePath rejects the reserved SKILL.md subtree", () => {
    // the mount synthesizes SKILL.md from the pinned version body; a resource
    // file at that path (in any normalized form) or under it would clobber the
    // manifest or replay-fail, breaking every later run_command.
    for (const reserved of [
      "SKILL.md",
      "./SKILL.md",
      "SKILL.md/injected.txt",
      "./SKILL.md/injected.txt",
    ]) {
      expect(() =>
        __internals.validateSkillMountFilePath("alpha", reserved),
      ).toThrow("invalid file path");
    }
    // absolute paths, traversal, and degenerate paths stay rejected.
    for (const bad of ["/etc/passwd", "../escape", ".", "scripts/../../x"]) {
      expect(() =>
        __internals.validateSkillMountFilePath("alpha", bad),
      ).toThrow("invalid file path");
    }
    // a SKILL.md nested under a subdirectory is fine — only the root is reserved.
    for (const ok of ["references/a.md", "scripts/run.py", "docs/SKILL.md"]) {
      expect(() =>
        __internals.validateSkillMountFilePath("alpha", ok),
      ).not.toThrow();
    }
  });

  test("sanitizeAttachmentName strips unsafe chars and directory/leading dots", () => {
    const { sanitizeAttachmentName } = __internals;
    expect(sanitizeAttachmentName("pi mc.gif", "id")).toBe("pi_mc.gif");
    expect(sanitizeAttachmentName('a"b`$c.png', "id")).toBe("a_b__c.png");
    expect(sanitizeAttachmentName("dir/sub/f.csv", "id")).toBe("f.csv");
    // leading dots can't escape; ".." reduces to nothing -> id fallback.
    expect(sanitizeAttachmentName("..", "abcd1234efgh")).toBe(
      "attachment-abcd1234",
    );
    expect(sanitizeAttachmentName(null, "abcd1234efgh")).toBe(
      "attachment-abcd1234",
    );
  });

  test("assignAttachmentPaths suffixes duplicate names deterministically", () => {
    const paths = __internals.assignAttachmentPaths([
      { id: "1111aaaabbbb", originalName: "out.png" },
      { id: "2222ccccdddd", originalName: "out.png" },
      { id: "3333eeeeffff", originalName: "notes.txt" },
    ]);
    // first claim keeps the plain name; the collision gets an id suffix before
    // the extension; unique names are untouched.
    expect(paths.get("1111aaaabbbb")).toBe("/home/sandbox/attachments/out.png");
    expect(paths.get("2222ccccdddd")).toBe(
      "/home/sandbox/attachments/out-2222cccc.png",
    );
    expect(paths.get("3333eeeeffff")).toBe(
      "/home/sandbox/attachments/notes.txt",
    );
  });

  test("planAttachmentStaging skips staged ids and flags oversize with a notice", () => {
    const attachments = [
      { id: "a", originalName: "small.csv", fileSize: 10 },
      { id: "b", originalName: "huge.bin", fileSize: 999 },
      { id: "c", originalName: "done.txt", fileSize: 5 },
    ];
    const { toStage, notices } = __internals.planAttachmentStaging({
      attachments,
      stagedIds: new Set(["c"]),
      limit: 100,
    });
    // c already staged -> skipped; b over the limit -> notice, not staged.
    expect(toStage.map((s) => s.id)).toEqual(["a"]);
    expect(toStage[0]?.path).toBe("/home/sandbox/attachments/small.csv");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("huge.bin");
    expect(notices[0]).toContain("exceeds");
  });
});

describe("stageConversationAttachments (db)", () => {
  test("stages conversation attachments as ordered upload replay events", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    if (!conversation) throw new Error("conversation seed failed");

    await seedAttachment({
      organizationId: org.id,
      conversationId: conversation.id,
      userId: user.id,
      name: "pi mc.gif",
      data: Buffer.from("GIF89a-bytes"),
    });

    const sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      defaultCwd: "/home/sandbox",
    });

    const notices = await __internals.stageConversationAttachments(sandbox);
    expect(notices).toEqual([]);

    const log = await SkillSandboxReplayEventModel.listBySandbox(sandbox.id);
    const uploads = log.filter((e) => e.kind === "upload");
    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    if (upload?.kind !== "upload") throw new Error("expected an upload event");
    // filename is sanitized (space -> underscore) and lands under the dir.
    expect(upload.upload.path).toBe("/home/sandbox/attachments/pi_mc.gif");
    expect(upload.upload.data?.toString("utf8")).toBe("GIF89a-bytes");
    expect(upload.upload.sourceAttachmentId).not.toBeNull();
  });

  test("is idempotent and picks up attachments added on a later turn", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    if (!conversation) throw new Error("conversation seed failed");

    await seedAttachment({
      organizationId: org.id,
      conversationId: conversation.id,
      userId: user.id,
      name: "first.csv",
      data: Buffer.from("a,b"),
    });
    const sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      defaultCwd: "/home/sandbox",
    });

    await __internals.stageConversationAttachments(sandbox);
    // a second pass over the same set must not double-stage.
    await __internals.stageConversationAttachments(sandbox);
    expect(
      uploadPaths(await SkillSandboxReplayEventModel.listBySandbox(sandbox.id)),
    ).toEqual(["/home/sandbox/attachments/first.csv"]);

    // a new attachment arrives mid-conversation; the next pass stages just it.
    await seedAttachment({
      organizationId: org.id,
      conversationId: conversation.id,
      userId: user.id,
      name: "second.csv",
      data: Buffer.from("c,d"),
    });
    await __internals.stageConversationAttachments(sandbox);
    expect(
      uploadPaths(
        await SkillSandboxReplayEventModel.listBySandbox(sandbox.id),
      ).sort(),
    ).toEqual([
      "/home/sandbox/attachments/first.csv",
      "/home/sandbox/attachments/second.csv",
    ]);
  });

  test("does not auto-stage a fresh (non-default) sandbox", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    if (!conversation) throw new Error("conversation seed failed");
    await seedAttachment({
      organizationId: org.id,
      conversationId: conversation.id,
      userId: user.id,
      name: "x.bin",
      data: Buffer.from("x"),
    });

    const fresh = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      defaultCwd: "/home/sandbox",
      isDefault: false,
    });
    expect(await __internals.stageConversationAttachments(fresh)).toEqual([]);
    expect(
      uploadPaths(await SkillSandboxReplayEventModel.listBySandbox(fresh.id)),
    ).toEqual([]);
  });

  test("never pulls another conversation's attachments", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const convA = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    const convB = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    if (!convA || !convB) throw new Error("conversation seed failed");

    // attachment lives in conversation B only.
    await seedAttachment({
      organizationId: org.id,
      conversationId: convB.id,
      userId: user.id,
      name: "secret.txt",
      data: Buffer.from("nope"),
    });

    const sandboxA = await SkillSandboxModel.findOrCreateDefault({
      organizationId: org.id,
      userId: user.id,
      conversationId: convA.id,
      defaultCwd: "/home/sandbox",
    });
    expect(await __internals.stageConversationAttachments(sandboxA)).toEqual(
      [],
    );
    expect(
      uploadPaths(
        await SkillSandboxReplayEventModel.listBySandbox(sandboxA.id),
      ),
    ).toEqual([]);
  });
});

describe("uploadFile dedupeId idempotency (db)", () => {
  /**
   * Tests the dedup mechanism at the model layer — the same layer `uploadFile`
   * delegates to — because the runtime service's `ensureEnabled()` guard
   * requires a live Dagger runner which is not available in the test environment.
   * The service-layer wiring (passing `dedupeId` → `sourceAttachmentId` →
   * conflict handling) is covered by the runtime-service unit tests above.
   */
  test("same dedupeId → one skill_sandbox_files row + one replay event; no-throw on repeat; different dedupeId still appends", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    if (!conversation) throw new Error("conversation seed failed");

    const sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: org.id,
      userId: user.id,
      conversationId: conversation.id,
      defaultCwd: "/home/sandbox",
    });

    const dedupeId = crypto.randomUUID();
    const fileData = Buffer.from("print('hello')", "utf8");

    // First insert — should create a file row and a replay event.
    const row1 = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      userId: user.id,
      path: "/home/sandbox/hooks/h/script.py",
      mimeType: "text/x-python",
      originalName: null,
      sizeBytes: fileData.byteLength,
      data: fileData,
      sourceAttachmentId: dedupeId,
    });
    expect(row1).not.toBeNull();
    expect(row1?.id).toBeTruthy();

    // Second append with the same dedupeId — ON CONFLICT → returns null (no-op).
    const row2 = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      userId: user.id,
      path: "/home/sandbox/hooks/h/script.py",
      mimeType: "text/x-python",
      originalName: null,
      sizeBytes: fileData.byteLength,
      data: fileData,
      sourceAttachmentId: dedupeId,
    });
    expect(row2).toBeNull();

    // Exactly one upload event in the replay log despite two calls.
    const log = await SkillSandboxReplayEventModel.listBySandbox(sandbox.id);
    const uploads = log.filter((e) => e.kind === "upload");
    expect(uploads).toHaveLength(1);

    // The file model can look up the already-staged row by (sandboxId, dedupeId).
    const existing = await SkillSandboxFileModel.findUploadByDedupeId(
      sandbox.id,
      dedupeId,
    );
    expect(existing).not.toBeNull();
    expect(existing?.id).toBe(row1?.id);

    // A different dedupeId → a new distinct row + replay event.
    const otherDedupeId = crypto.randomUUID();
    const row3 = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      userId: user.id,
      path: "/home/sandbox/hooks/h/other.py",
      mimeType: "text/x-python",
      originalName: null,
      sizeBytes: 7,
      data: Buffer.from("exit(0)", "utf8"),
      sourceAttachmentId: otherDedupeId,
    });
    expect(row3).not.toBeNull();
    expect(row3?.id).not.toBe(row1?.id);

    const logAfter = await SkillSandboxReplayEventModel.listBySandbox(
      sandbox.id,
    );
    expect(logAfter.filter((e) => e.kind === "upload")).toHaveLength(2);

    // An upload without a sourceAttachmentId (no dedupeId) also appends normally.
    const row4 = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      userId: user.id,
      path: "/home/sandbox/hooks/h/payload.json",
      mimeType: "application/json",
      originalName: null,
      sizeBytes: 2,
      data: Buffer.from("{}", "utf8"),
    });
    expect(row4).not.toBeNull();

    const logFinal = await SkillSandboxReplayEventModel.listBySandbox(
      sandbox.id,
    );
    expect(logFinal.filter((e) => e.kind === "upload")).toHaveLength(3);
  });
});

describe("path validation vectors (mirrored with sandbox-core)", () => {
  // mirrored with UPLOAD_PATH_VECTORS / ARTIFACT_PATH_VECTORS in
  // archestra-rs/sandbox-core/src/validation.rs — keep the two tables in sync
  // when adding cases. the Rust module is the trust boundary and stays
  // authoritative; this layer rejects early for friendlier errors and to keep
  // unreplayable events out of the log. the third column documents the Rust
  // verdict on the same string so divergences are explicit.
  const DEFAULT_CWD = "/home/sandbox";

  // (path, acceptedHere, acceptedByRust)
  const UPLOAD_PATH_VECTORS: Array<[string, boolean, boolean]> = [
    ["/home/sandbox/input.csv", true, true],
    ["/skills/alpha/data/in.bin", true, true],
    // relative: resolved against defaultCwd before validation, so it is
    // accepted here while the raw string would be rejected at the boundary
    ["input.csv", true, false],
    // outside roots
    ["/etc/passwd", false, false],
    // traversal
    ["/home/sandbox/../etc/passwd", false, false],
    // directory, not a file
    ["/home/sandbox/", false, false],
    // a root itself: rejected here before it is persisted as an unreplayable
    // event; the boundary alone would accept it
    ["/home/sandbox", false, true],
    // shell metacharacters / control chars / null
    ['/home/sandbox/a"b', false, false],
    ["/home/sandbox/a$b", false, false],
    ["/home/sandbox/a`b", false, false],
    ["/home/sandbox/a\\b", false, false],
    ["/home/sandbox/a\nb", false, false],
    ["/home/sandbox/a\rb", false, false],
    ["/home/sandbox/a\0b", false, false],
  ];

  // (path, acceptedHere, acceptedByRust)
  const ARTIFACT_PATH_VECTORS: Array<[string, boolean, boolean]> = [
    ["/skills/alpha/result.txt", true, true],
    ["out/report.txt", true, true],
    // outside roots
    ["/etc/passwd", false, false],
    // traversal
    ["a/../b.txt", false, false],
    // null byte
    ["a\0b.txt", false, false],
    // shell metacharacters: pass through here; the Rust boundary rejects them
    ['/skills/alpha/foo"bar', true, false],
    ["/skills/alpha/foo$bar", true, false],
    ["/skills/alpha/foo`bar", true, false],
    ["/skills/alpha/foo\\bar", true, false],
    ["/skills/alpha/foo\nbar", true, false],
    ["/skills/alpha/foo\rbar", true, false],
  ];

  test("upload path vectors", () => {
    const stageUpload = (path: string) => {
      const resolved = __internals.resolveArtifactPath({
        path,
        defaultCwd: DEFAULT_CWD,
      });
      __internals.validateUploadPath(resolved);
    };
    for (const [path, accepted] of UPLOAD_PATH_VECTORS) {
      if (accepted) {
        expect(
          () => stageUpload(path),
          `upload path: ${JSON.stringify(path)}`,
        ).not.toThrow();
      } else {
        expect(
          () => stageUpload(path),
          `upload path: ${JSON.stringify(path)}`,
        ).toThrow();
      }
    }
  });

  test("artifact path vectors", () => {
    for (const [path, accepted] of ARTIFACT_PATH_VECTORS) {
      const resolve = () =>
        __internals.resolveArtifactPath({ path, defaultCwd: DEFAULT_CWD });
      if (accepted) {
        expect(resolve, `artifact path: ${JSON.stringify(path)}`).not.toThrow();
      } else {
        expect(resolve, `artifact path: ${JSON.stringify(path)}`).toThrow();
      }
    }
  });
});
