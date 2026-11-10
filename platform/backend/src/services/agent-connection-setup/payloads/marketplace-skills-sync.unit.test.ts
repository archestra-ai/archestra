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
import { F52_MARKETPLACE_SKILLS_SYNC } from "../../../test/fixtures/f52-marketplace-skills-sync";
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
  const run = (
    value: (typeof source & { organizationId?: string }) | null = source,
    install = false,
    payload = MARKETPLACE_SKILLS_SYNC,
  ) =>
    spawnSync(process.execPath, ["-"], {
      input: `${payload}\ntry { console.log(syncMarketplaceSkills(${JSON.stringify({ source: value, install })}) || "none"); } catch (error) { console.error(error.message); process.exitCode = 1; }`,
      env: {
        ...process.env,
        HOME: home,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
      },
      encoding: "utf8",
    });
  const location = (value = source) =>
    new Function(
      "require",
      "source",
      `${MARKETPLACE_SKILLS_SYNC}; return marketplaceSkillsLocation(source).repository;`,
    )(
      (id: string) =>
        id === "node:os" ? { homedir: () => home } : require(id),
      value,
    );
  return {
    root,
    home,
    remote,
    source,
    get checkout() {
      return location();
    },
    location,
    skill,
    commit,
    run,
  };
}

test("a new approved server isolates its checkout from a foreign legacy marketplace", () => {
  const current = fixture();
  const first = current.run(current.source, true, F52_MARKETPLACE_SKILLS_SYNC);
  expect(first.status, first.stderr).toBe(0);
  const legacy = first.stdout.trim();
  const marker = path.join(legacy, "../../../.git/archestra-skills.json");
  const before = readFileSync(marker, "utf8");
  const next = {
    ...current.source,
    cloneUrl: "http://localhost:3300/repo.git",
  };
  writeFileSync(
    path.join(current.root, "gitconfig"),
    `[url "${new URL(`file://${current.remote}/`).href}"]\n insteadOf = https://marketplace.example/repo.git\n insteadOf = http://localhost:3300/repo.git\n`,
  );
  const result = current.run(next, true);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).not.toBe(legacy);
  expect(readFileSync(marker, "utf8")).toBe(before);
  expect(
    current.run(current.source, false, F52_MARKETPLACE_SKILLS_SYNC).status,
  ).toBe(0);
});

test.each([
  { first: "http://localhost:3300", next: "http://127.0.0.1:3300", same: true },
  {
    first: "http://stack-a.localhost:3300",
    next: "http://stack-b.localhost:3300",
    same: false,
  },
  {
    first: "http://stack-a.localhost:3300",
    next: "http://127.0.0.1:3300",
    same: false,
  },
  {
    first: "http://localhost:3300",
    next: "http://127.0.0.1:3000",
    same: false,
  },
  {
    first: "http://localhost:3300",
    next: "https://localhost:3300",
    same: false,
  },
  {
    first: "https://first.example",
    next: "https://second.example",
    same: false,
  },
])("approved scope canonicalization: $first -> $next; same=$same", ({
  first,
  next,
  same,
}) => {
  const current = fixture();
  writeFileSync(
    path.join(current.root, "gitconfig"),
    `[url "${new URL(`file://${current.remote}/`).href}"]\n insteadOf = ${first}/old.git\n insteadOf = ${next}/new.git\n insteadOf = http://127.0.0.1:3300/old.git\n insteadOf = http://127.0.0.1:3300/new.git\n`,
  );
  const oldSource = {
    ...current.source,
    cloneUrl: `${first}/old.git`,
    organizationId: "org-a",
  };
  const nextSource = { ...oldSource, cloneUrl: `${next}/new.git` };
  const initial = current.run(oldSource, true);
  expect(initial.status, initial.stderr).toBe(0);
  const repeated = current.run(nextSource, true);
  expect(repeated.status, repeated.stderr).toBe(0);
  expect(repeated.stdout.trim() === initial.stdout.trim()).toBe(same);
  expect(current.run(oldSource).status).toBe(0);
  expect(current.run(nextSource).status).toBe(0);
  expect(repeated.stdout).not.toContain("org-a");
});

test("installs and refreshes named localhost skills through loopback without changing ownership", () => {
  const current = fixture();
  const source = {
    ...current.source,
    cloneUrl: "http://stack-a.localhost:3300/repo.git",
  };
  writeFileSync(
    path.join(current.root, "gitconfig"),
    `[url "${new URL(`file://${current.remote}/`).href}"]\n insteadOf = http://127.0.0.1:3300/repo.git\n`,
  );
  const installed = current.run(source, true);
  expect(installed.status, installed.stderr).toBe(0);
  const checkout = current.location(source);
  expect(readFileSync(path.join(checkout, current.skill), "utf8")).toContain(
    "test fractions",
  );
  const owner = JSON.parse(
    readFileSync(path.join(checkout, ".git/archestra-skills.json"), "utf8"),
  );
  expect(owner.origin).toBe("http://stack-a.localhost:3300");
  current.commit(current.skill, "Updated skill\n");
  const refreshed = current.run(source);
  expect(refreshed.status, refreshed.stderr).toBe(0);
  expect(readFileSync(path.join(checkout, current.skill), "utf8")).toBe(
    "Updated skill\n",
  );
});

test.each([
  "http://remote.example/repo.git",
  "http://stack.localhost.example/repo.git",
  "http://notlocalhost/repo.git",
  "http://localhost@remote.example/repo.git",
  "http://192.0.2.1/repo.git",
  "ftp://stack.localhost/repo.git",
  "file:///tmp/repo.git",
])("rejects non-loopback HTTP and non-HTTP(S) skills sources: %s", (cloneUrl) => {
  const current = fixture();
  const rejected = current.run({ ...current.source, cloneUrl }, true);
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain(
    "Shared skills require HTTPS or a local development connection.",
  );
  expect(existsSync(path.join(current.home, ".archestra"))).toBe(false);
});

test("foreign dirty legacy data is left untouched while the new scoped checkout still refuses local edits", () => {
  const current = fixture();
  const old = current.run(current.source, true, F52_MARKETPLACE_SKILLS_SYNC);
  expect(old.status, old.stderr).toBe(0);
  const oldSkill = path.join(old.stdout.trim(), "check-add/SKILL.md");
  writeFileSync(oldSkill, "FOREIGN USER EDITS\r\n");
  const next = {
    ...current.source,
    organizationId: "org-b",
    cloneUrl: "https://another.example/repo.git",
  };
  writeFileSync(
    path.join(current.root, "gitconfig"),
    `[url "${new URL(`file://${current.remote}/`).href}"]\n insteadOf = ${next.cloneUrl}\n`,
  );
  const setup = current.run(next, true);
  expect(setup.status, setup.stderr).toBe(0);
  expect(readFileSync(oldSkill, "utf8")).toBe("FOREIGN USER EDITS\r\n");
  const ownSkill = path.join(setup.stdout.trim(), "check-add/SKILL.md");
  writeFileSync(ownSkill, "OWN USER EDITS\r\n");
  expect(current.run(next, true).status).not.toBe(0);
  expect(readFileSync(ownSkill, "utf8")).toBe("OWN USER EDITS\r\n");
  expect(readFileSync(oldSkill, "utf8")).toBe("FOREIGN USER EDITS\r\n");
});

test("a same-source legacy checkout without organization metadata remains shared with the old client", () => {
  const current = fixture();
  const initial = current.run(
    current.source,
    true,
    F52_MARKETPLACE_SKILLS_SYNC,
  );
  expect(initial.status, initial.stderr).toBe(0);
  const next = current.run(
    { ...current.source, organizationId: "org-a" },
    true,
  );
  expect(next.status, next.stderr).toBe(0);
  expect(next.stdout).toBe(initial.stdout);
  const oldClient = current.run(
    current.source,
    false,
    F52_MARKETPLACE_SKILLS_SYNC,
  );
  expect(oldClient.status, oldClient.stderr).toBe(0);
  expect(oldClient.stdout).toBe(initial.stdout);
});

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
  expect(f.run().status).toBe(0);
});

test("reconnect accepts an approved loopback alias and rotated source without deleting a shared clean checkout", () => {
  const f = fixture();
  const oldSource = {
    ...f.source,
    cloneUrl: "http://localhost:9300/share/old/repo.git",
  };
  const next = {
    ...f.source,
    cloneUrl: "http://127.0.0.1:9300/share/new/repo.git",
  };
  writeFileSync(
    path.join(f.root, "gitconfig"),
    `[url "${new URL(`file://${f.remote}/`).href}"]\n insteadOf = http://localhost:9300/share/old/repo.git\n insteadOf = http://127.0.0.1:9300/share/new/repo.git\n`,
  );
  expect(f.run(oldSource, true).status).toBe(0);
  f.commit("selected.txt", "new approved selection\r\n");
  const reconnect = f.run(next, true);
  expect(reconnect.status, reconnect.stderr).toBe(0);
  expect(
    readFileSync(path.join(f.location(oldSource), "selected.txt"), "utf8"),
  ).toBe("new approved selection\r\n");
  expect(f.run(oldSource).status).toBe(0);
});

test("reconciles a clean cross-client checkout advanced to the same authenticated remote HEAD", () => {
  const f = fixture();
  expect(f.run(f.source, true).status).toBe(0);
  f.commit("updated.txt", "another client refreshed this\n");
  execFileSync("git", ["-C", f.checkout, "fetch", f.remote, "HEAD"], {
    stdio: "pipe",
  });
  execFileSync(
    "git",
    ["-C", f.checkout, "checkout", "--detach", "FETCH_HEAD"],
    { stdio: "pipe" },
  );
  const reconnect = f.run(f.source, true);
  expect(reconnect.status, reconnect.stderr).toBe(0);
  expect(f.run().status).toBe(0);
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

test("approved reconnect isolates server and organization boundaries and preserves previous sources", () => {
  const current = fixture();
  expect(current.run(current.source, true).status).toBe(0);
  const source = { ...current.source, organizationId: "synthetic-org-a" };
  expect(current.run(source, true).status).toBe(0);
  expect(current.run(current.source).status).toBe(0);
  const wrongOrganization = current.run(
    { ...source, organizationId: "synthetic-org-b" },
    true,
  );
  expect(wrongOrganization.status, wrongOrganization.stderr).toBe(0);
  expect(wrongOrganization.stdout).not.toBe(current.run(source).stdout);
  const wrongOrigin = current.run(
    { ...source, cloneUrl: "https://different.example/repo.git" },
    true,
  );
  expect(wrongOrigin.status).toBe(1);
  expect(wrongOrigin.stderr).toContain("could not be refreshed");
  expect(current.run(source).status).toBe(0);
});

test("refuses unknown clean local commits and case collisions without overwriting user data", () => {
  const current = fixture();
  expect(current.run(current.source, true).status).toBe(0);
  writeFileSync(
    path.join(current.checkout, "local.txt"),
    "keep this local commit\r\n",
  );
  execFileSync("git", ["-C", current.checkout, "add", "local.txt"]);
  execFileSync(
    "git",
    [
      "-C",
      current.checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "Local fixture",
    ],
    { stdio: "pipe" },
  );
  const rejected = current.run(current.source, true);
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("local commits manually");
  expect(readFileSync(path.join(current.checkout, "local.txt"), "utf8")).toBe(
    "keep this local commit\r\n",
  );
  const collision = fixture();
  collision.commit("File.txt", "first\r\n");
  collision.commit("file.txt", "second\r\n");
  expect(collision.run(collision.source, true).stderr).toContain(
    "Case-colliding",
  );
  expect(existsSync(collision.checkout)).toBe(false);
});
