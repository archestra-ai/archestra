import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MARKETPLACE_SKILLS_SYNC } from "./marketplace-skills-sync";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "marketplace 日本語 "));
  roots.push(root);
  const home = path.join(root, "home"),
    remote = path.join(root, "remote");
  mkdirSync(home);
  mkdirSync(remote);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", remote, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "--quiet");
  const commit = (name: string, content: string | null) => {
    const file = path.join(remote, name);
    if (content === null) git("rm", "--", name);
    else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    git("add", "-A");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "Fixture revision",
    );
  };
  const skill = "plugins/team-skills/skills/check-add/SKILL.md";
  commit(
    skill,
    "---\nname: check-add\ndescription: Verify arithmetic tasks.\n---\nRead references/checks.md and test fractions.\n",
  );
  commit(
    "plugins/team-skills/skills/check-add/references/checks.md",
    "Check positive, negative and fractional sums.",
  );
  const globalConfig = path.join(root, "gitconfig");
  // Only the network boundary is redirected. All Git and filesystem behavior
  // in the shipped payload runs unchanged, including checkout conflict checks.
  writeFileSync(
    globalConfig,
    `[url "${new URL(`file://${remote}/`).href}"]\n insteadOf = https://marketplace.example/repo.git\n`,
  );
  const source = {
    cloneUrl: "https://marketplace.example/repo.git",
    marketplaceName: "team-skills",
  };
  const run = (value: typeof source | null = source, install = false) =>
    spawnSync(process.execPath, ["-"], {
      input: `${MARKETPLACE_SKILLS_SYNC}\ntry { console.log(syncMarketplaceSkills(${JSON.stringify({ source: value, install })}) || "none"); } catch (error) { console.error(error.message); process.exitCode = 1; }`,
      env: {
        ...process.env,
        HOME: home,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
      },
      encoding: "utf8",
    });
  const checkout = path.join(home, ".archestra/skills/team-skills");
  return { root, home, remote, source, checkout, skill, commit, run };
}

test("refreshes native skill files and resources idempotently; removes only tracked stale files and preserves user skills", () => {
  const f = fixture();
  mkdirSync(path.join(f.home, ".pi/agent/skills/personal"), {
    recursive: true,
  });
  writeFileSync(
    path.join(f.home, ".pi/agent/skills/personal/SKILL.md"),
    "Personal skill",
  );
  const first = f.run();
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout.trim()).toBe(
    path.join(f.checkout, "plugins/team-skills/skills"),
  );
  expect(f.run().status).toBe(0);
  const personal = path.join(f.checkout, "user-note.txt");
  writeFileSync(personal, "keep");
  f.commit(
    f.skill,
    "---\nname: check-add\ndescription: Updated task guidance.\n---\nUse the new checks.\n",
  );
  f.commit("plugins/team-skills/skills/check-add/references/checks.md", null);
  expect(f.run().status).toBe(0);
  expect(readFileSync(path.join(f.checkout, f.skill), "utf8")).toContain(
    "new checks",
  );
  expect(
    existsSync(
      path.join(
        f.checkout,
        "plugins/team-skills/skills/check-add/references/checks.md",
      ),
    ),
  ).toBe(false);
  expect(readFileSync(personal, "utf8")).toBe("keep");
  expect(
    readFileSync(
      path.join(f.home, ".pi/agent/skills/personal/SKILL.md"),
      "utf8",
    ),
  ).toBe("Personal skill");
  const owner = JSON.parse(
    readFileSync(path.join(f.checkout, ".git/archestra-skills.json"), "utf8"),
  );
  expect(owner.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(owner.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(
    readFileSync(path.join(f.checkout, ".git/config"), "utf8"),
  ).not.toContain(f.source.cloneUrl);
  expect(f.run(null).stdout.trim()).toBe("none");
  expect(readFileSync(personal, "utf8")).toBe("keep");
});

test("refuses modified managed files and unowned destinations rather than overwriting them", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  writeFileSync(path.join(f.checkout, f.skill), "my edits");
  const result = f.run();
  expect(result.status).toBe(1);
  expect(readFileSync(path.join(f.checkout, f.skill), "utf8")).toBe("my edits");
  rmSync(path.join(f.checkout, ".git/archestra-skills.json"));
  expect(f.run().stderr).toContain("not managed");
});

test("refuses linked ancestors before writing outside the owned checkout", () => {
  const f = fixture();
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  mkdirSync(path.join(f.home, ".archestra"));
  symlinkSync(outside, path.join(f.home, ".archestra/skills"));
  const result = f.run();
  expect(result.status).toBe(1);
  expect(existsSync(path.join(outside, "team-skills"))).toBe(false);
});

test.each([
  "unsafe:windows",
  "../escape",
  "con",
  "bad.",
])("rejects unsafe marketplace names on every platform: %s", (name) => {
  const f = fixture();
  expect(f.run({ ...f.source, marketplaceName: name }).status).toBe(1);
});

test("rejects remote symlink entries before checkout; a corrected first installation can be retried", () => {
  const f = fixture();
  symlinkSync("/tmp/outside", path.join(f.remote, "bad-link"));
  f.commit("revision.txt", "symlink revision");
  const rejected = f.run();
  expect(rejected.status, rejected.stderr).toBe(1);
  expect(rejected.stderr).toContain(
    "The skills marketplace contains a link or unsupported file.",
  );
  expect(existsSync(f.checkout)).toBe(false);
  f.commit("bad-link", null);
  const retry = f.run();
  expect(retry.status, retry.stderr).toBe(0);
});

test("reinstall changes selected scope but startup rejects an unapproved source change", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const next = { ...f.source, cloneUrl: `${f.source.cloneUrl}/` };
  expect(f.run(next).status).toBe(1);
  f.commit(f.skill, null);
  const installed = f.run(next, true);
  expect(installed.status, installed.stderr).toBe(0);
  expect(existsSync(path.join(f.checkout, f.skill))).toBe(false);
  expect(f.run(next).status).toBe(0);
  expect(f.run().status).toBe(1);
});

test("fails closed on refresh errors and preserves conflicting untracked user files", () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  const userFile = path.join(f.checkout, "user.txt");
  writeFileSync(userFile, "user content");
  f.commit("user.txt", "remote content");
  expect(f.run().status).toBe(1);
  expect(readFileSync(userFile, "utf8")).toBe("user content");
  rmSync(f.remote, { recursive: true });
  const failed = f.run();
  expect(failed.status).toBe(1);
  expect(failed.stdout.trim()).toBe("");
  expect(failed.stderr).not.toContain(f.source.cloneUrl);
});
