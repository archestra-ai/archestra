/**
 * Native directory clients consume the existing authenticated Git marketplace.
 * The checkout belongs to the first deployment that made it. `root` gives a
 * client its own checkouts instead of the shared ~/.archestra/skills.
 */
export const MARKETPLACE_SKILLS_SYNC = String.raw`
function marketplaceSkillsIdentity(source) {
  const crypto = require("node:crypto");
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(source.marketplaceName) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(source.marketplaceName)) throw new Error("Invalid skills marketplace name.");
  if (source.organizationId !== undefined && (typeof source.organizationId !== "string" || !source.organizationId || source.organizationId.length > 256)) throw new Error("Invalid skills organization identity.");
  const url = new URL(source.cloneUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost")))) throw new Error("Shared skills require HTTPS or a local development connection.");
  const origin = marketplaceSkillsOrigin(url.origin);
  return { origin, scope: crypto.createHash("sha256").update(JSON.stringify([origin, source.organizationId || null, source.marketplaceName])).digest("hex").slice(0, 32) };
}
function marketplaceSkillsOrigin(value) {
  const origin = new URL(value);
  return ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ? origin.protocol + "//loopback:" + (origin.port || (origin.protocol === "https:" ? "443" : "80")) : origin.origin;
}
function safeMarketplaceSkillsPath(file) {
  const fs = require("node:fs"), path = require("node:path"), home = path.resolve(require("node:os").homedir());
  let current = path.resolve(file);
  if (!current.startsWith(home + path.sep)) throw new Error("Skills must stay inside the home directory.");
  while (current !== home) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))) throw new Error("Refusing linked or unowned skills files.");
    current = path.dirname(current);
  }
}
function marketplaceSkillsLocation(source, root) {
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
  const identity = marketplaceSkillsIdentity(source), base = root || path.join(require("node:os").homedir(), ".archestra", "skills");
  const scoped = path.join(base, source.marketplaceName + "--" + identity.scope), legacy = path.join(base, source.marketplaceName);
  safeMarketplaceSkillsPath(scoped);
  if (fs.existsSync(scoped)) return { ...identity, repository: scoped };
  safeMarketplaceSkillsPath(legacy);
  if (fs.existsSync(legacy)) {
    const marker = path.join(legacy, ".git", "archestra-skills.json");
    safeMarketplaceSkillsPath(marker);
    if (!fs.existsSync(marker)) throw new Error("The skills directory is not managed by this connection. Preserve it and reconcile its ownership before connecting.");
    const owner = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (owner.format !== 1) throw new Error("Shared skills ownership format is not recognized. Preserve the checkout and reconcile its managed marker manually.");
    const approved = [owner.sourceFingerprint, ...(owner.approvedSources || [])];
    const fingerprint = crypto.createHash("sha256").update(source.cloneUrl).digest("hex");
    const sameOrganization = owner.organizationId ? (source.organizationId ? owner.organizationId === source.organizationId : approved.includes(fingerprint)) : (!source.organizationId || approved.includes(fingerprint));
    if (marketplaceSkillsOrigin(owner.origin) === identity.origin && sameOrganization) return { ...identity, repository: legacy };
  }
  return { ...identity, repository: scoped };
}
function syncMarketplaceSkills({ source, install = false, root = null }) {
  if (!source) return;
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
  const { execFileSync } = require("node:child_process");
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(source.marketplaceName) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(source.marketplaceName)) throw new Error("Invalid skills marketplace name.");
  const url = new URL(source.cloneUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost")))) throw new Error("Shared skills require HTTPS or a local development connection.");
  const home = os.homedir(), destination = marketplaceSkillsLocation(source, root).repository;
  const safe = file => {
    let current = path.resolve(file);
    if (!current.startsWith(path.resolve(home) + path.sep)) throw new Error("Skills must stay inside the home directory.");
    while (current !== path.resolve(home)) {
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (stat && (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))) throw new Error("Refusing linked or unowned skills files.");
      current = path.dirname(current);
    }
  };
  safe(destination);
  const existed = fs.existsSync(destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const directory = existed ? destination : fs.mkdtempSync(destination + ".installing-");
  try {
  const gitDirectory = path.join(directory, ".git"), ownerFile = path.join(gitDirectory, "archestra-skills.json");
  safe(ownerFile);
  const fingerprint = crypto.createHash("sha256").update(source.cloneUrl).digest("hex");
  if (existed && !fs.existsSync(ownerFile)) throw new Error("The skills directory is not managed by this connection. Move it before connecting.");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Match the bootstrap's loopback transport on systems without .localhost DNS.
  // Keep the approved named origin above for checkout ownership and consent.
  let cloneUrl = source.cloneUrl;
  if (url.protocol === "http:" && url.hostname.endsWith(".localhost")) {
    const networkUrl = new URL(url);
    networkUrl.hostname = "127.0.0.1";
    cloneUrl = networkUrl.href;
  }
  // The credential-bearing URL travels in the subprocess environment, not argv or output.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: cloneUrl, GIT_CONFIG_KEY_1: "remote.origin.fetch", GIT_CONFIG_VALUE_1: "+refs/heads/*:refs/remotes/origin/*" };
  const git = (...args) => {
    try { return execFileSync("git", ["-c", "core.hooksPath=" + path.join(gitDirectory, "archestra-no-hooks"), "-c", "core.fsmonitor=false", "-C", directory, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, maxBuffer: 16 * 1024 * 1024 }); }
    catch { throw new Error("Shared skills could not be refreshed. Check the connection and keep local edits outside its managed skill files."); }
  };
  let previousOwner = null, previousHead = null;
  if (existed) {
    previousOwner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    if (previousOwner.format !== 1) throw new Error("Shared skills ownership format is not recognized. Preserve the checkout and reconcile its managed marker manually.");
    if (marketplaceSkillsOrigin(previousOwner.origin) !== marketplaceSkillsOrigin(url.origin)) throw new Error("Shared skills belong to a different server origin. Preserve the checkout; use a distinct marketplace name for the other server.");
    const approved = [previousOwner.sourceFingerprint, ...(previousOwner.approvedSources || [])];
    if (previousOwner.organizationId && (source.organizationId ? source.organizationId !== previousOwner.organizationId : !approved.includes(fingerprint))) throw new Error("Shared skills belong to a different organization. Preserve the checkout; use a distinct marketplace name.");
    if (!install && !approved.includes(fingerprint)) throw new Error("This shared skills source has not been approved on this machine. Run the newly approved connection installer; no files were overwritten.");
    previousHead = git("rev-parse", "HEAD").trim();
    git("diff", "--quiet"); git("diff", "--cached", "--quiet");
  } else {
    git("init", "--quiet");
  }
  safe(gitDirectory);
  const noHooks = path.join(gitDirectory, "archestra-no-hooks");
  safe(noHooks);
  if (!fs.existsSync(noHooks)) fs.writeFileSync(noHooks, "", { flag: "wx", mode: 0o600 });
  if (!fs.statSync(noHooks).isFile() || fs.statSync(noHooks).size !== 0) throw new Error("Unsafe shared skills hook configuration.");
  // This is the same Git repository/revision delivery used by OpenCode/Kilo.
  // Checkout changes only tracked marketplace files; untracked user files survive.
  git("fetch", "--quiet", "--no-tags", "--depth=1", "origin", "HEAD");
  if (previousOwner && previousOwner.revision !== previousHead && previousHead !== git("rev-parse", "FETCH_HEAD").trim()) throw new Error("Shared skills HEAD differs from both the recorded managed revision and the authenticated source. Preserve the checkout and reconcile its local commits manually.");
  const seen = new Set();
  for (const line of git("ls-tree", "-rz", "--full-tree", "FETCH_HEAD").split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob [0-9a-f]+\t(.+)$/s.exec(line);
    if (!match) throw new Error("The skills marketplace contains a link or unsupported file.");
    const name = match[2], segments = name.split("/");
    if (segments.some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:\.git|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe skills marketplace path.");
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error("Case-colliding skills marketplace paths.");
    seen.add(key); safe(path.join(directory, ...segments));
  }
  const approvedSources = [...new Set([...(previousOwner?.approvedSources || []), previousOwner?.sourceFingerprint, fingerprint].filter(Boolean))];
  if (approvedSources.length > 64) throw new Error("This shared checkout has too many approved sources. Preserve it and reconcile the managed source list manually.");
  git("checkout", "--quiet", "--detach", "FETCH_HEAD");
  const revision = git("rev-parse", "HEAD").trim();
  const owner = { format: 1, origin: previousOwner?.origin || url.origin, sourceFingerprint: previousOwner?.sourceFingerprint || fingerprint, approvedSources, organizationId: source.organizationId || previousOwner?.organizationId, revision };
  fs.writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600 });
  if (!existed) fs.renameSync(directory, destination);
  const skills = path.join(destination, "plugins", source.marketplaceName, "skills");
  safe(skills);
  if (!fs.existsSync(skills)) return; // The selected skills may have been removed upstream.
  return skills;
  } finally {
    if (!existed && fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
  }
}
`;
