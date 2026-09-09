import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

test("workspace transfers preserve bytes, require overwrite, and reject path escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-files-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const outside = path.join(root, "outside");
    await writeFile(outside, "outside must not change");
    await symlink(root, path.join(workspace, "escape"));
    await symlink(outside, path.join(workspace, "linked-file"));
    const bytes = Buffer.from([0, 255, 13, 10, 128, 65]);
    const content = bytes.toString("base64");
    expect(
      call({ operation: "write", path: "data.bin", content_base64: content })
        .ok,
    ).toBe(true);
    expect(call({ operation: "read", path: "data.bin" }).content_base64).toBe(
      content,
    );
    expect(
      call({ operation: "write", path: "data.bin", content_base64: "" }).ok,
    ).toBe(false);
    expect(
      call({
        operation: "write",
        path: "data.bin",
        content_base64: "",
        overwrite: true,
      }).ok,
    ).toBe(true);
    expect(await readFile(path.join(workspace, "data.bin"))).toHaveLength(0);
    await chmod(path.join(workspace, "data.bin"), 0o755);
    expect(
      call({
        operation: "write",
        path: "data.bin",
        content_base64: content,
        overwrite: true,
      }).ok,
    ).toBe(true);
    expect((await stat(path.join(workspace, "data.bin"))).mode & 0o777).toBe(
      0o755,
    );
    expect(
      call({
        operation: "write",
        path: "linked-file",
        content_base64: content,
        overwrite: true,
      }).ok,
    ).toBe(false);
    expect(
      call({
        operation: "write",
        path: "invalid",
        content_base64: "!not-base64!",
      }).ok,
    ).toBe(false);
    expect(
      call({
        operation: "write",
        path: "oversized",
        content_base64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
      }).ok,
    ).toBe(false);
    for (const unsafe of [
      "../outside",
      "/outside",
      "escape/outside",
      "linked-file",
    ]) {
      expect(call({ operation: "read", path: unsafe }).ok).toBe(false);
    }
    expect(
      call({
        operation: "write",
        path: "escape/outside",
        content_base64: content,
        overwrite: true,
      }).ok,
    ).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("outside must not change");
    await writeFile(
      path.join(workspace, "large"),
      Buffer.alloc(4 * 1024 * 1024 + 1),
    );
    expect(call({ operation: "read", path: "large" }).ok).toBe(false);

    function call(request: Record<string, unknown>) {
      const result = spawnSync(
        "python3",
        [
          path.resolve(
            import.meta.dirname,
            "../../../../agent_images/bin/archestra-workspace-files",
          ),
        ],
        {
          env: {
            ...process.env,
            ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ROOT: workspace,
          },
          input: JSON.stringify(request),
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.error).toBeUndefined();
      return JSON.parse(result.stdout);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
