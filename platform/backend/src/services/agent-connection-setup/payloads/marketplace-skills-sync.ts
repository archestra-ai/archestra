/** Native directory clients consume the existing authenticated Git marketplace. */
export const MARKETPLACE_SKILLS_SYNC = String.raw`
function syncMarketplaceSkills({ source, install = false }) {
  if (!source) return;
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
  const { execFileSync } = require("node:child_process");
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(source.marketplaceName) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(source.marketplaceName)) throw new Error("Invalid skills marketplace name.");
  const url = new URL(source.cloneUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Shared skills require HTTPS or a local development connection.");
  const home = os.homedir(), destination = path.join(home, ".archestra", "skills", source.marketplaceName);
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
  // The credential-bearing URL travels in the subprocess environment, not argv or output.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: source.cloneUrl, GIT_CONFIG_KEY_1: "remote.origin.fetch", GIT_CONFIG_VALUE_1: "+refs/heads/*:refs/remotes/origin/*" };
  const git = (...args) => {
    try { return execFileSync("git", ["-c", "core.hooksPath=" + path.join(gitDirectory, "archestra-no-hooks"), "-c", "core.fsmonitor=false", "-C", directory, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, maxBuffer: 16 * 1024 * 1024 }); }
    catch { throw new Error("Shared skills could not be refreshed. Check the connection and keep local edits outside its managed skill files."); }
  };
  if (existed) {
    const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    if (owner.format !== 1 || owner.origin !== url.origin || (!install && owner.sourceFingerprint !== fingerprint) || owner.revision !== git("rev-parse", "HEAD").trim()) throw new Error("Shared skills ownership or source changed. Rerun connection setup.");
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
  git("checkout", "--quiet", "--detach", "FETCH_HEAD");
  const revision = git("rev-parse", "HEAD").trim();
  const owner = { format: 1, origin: url.origin, sourceFingerprint: fingerprint, revision };
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
