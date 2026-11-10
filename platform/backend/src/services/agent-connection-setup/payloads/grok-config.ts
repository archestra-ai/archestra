import { GROK_TOML } from "./grok-toml.generated";

export const GROK_CONFIG = `${GROK_TOML}
${String.raw`
function readGrokToml(text) {
  let document;
  try { document = grokToml.parse(text.replace(/^\uFEFF/, ""), { integersAsBigInt: "asNeeded" }); }
  catch { throw new Error("Grok config is invalid or has duplicate TOML definitions. No configuration was replaced; validate it locally without sharing its contents."); }
  if (document.models !== undefined && (!document.models || typeof document.models !== "object" || Array.isArray(document.models) || document.models instanceof Date)) throw new Error("Grok models must be a TOML table before managed routing; no settings were replaced.");
  return document;
}
function equalGrokValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  if (left instanceof Date || right instanceof Date) return require("node:util").isDeepStrictEqual(left, right);
  const keys = Object.keys(left).sort();
  return require("node:util").isDeepStrictEqual(keys, Object.keys(right).sort()) && keys.every(key => equalGrokValue(left[key], right[key]));
}
function ownedGrokTables(state) {
  if (state.format !== undefined && state.format !== 2) throw new Error("Unsupported Grok snapshot version; preserve the private connection directory.");
  if (typeof state.block !== "string") throw new Error("Grok snapshot has no known semantic ownership record.");
  const expected = readGrokToml(state.block), tables = [];
  if (Object.keys(expected).some(key => !["model", "mcp_servers"].includes(key))) throw new Error("Grok snapshot has unknown managed paths.");
  for (const [parent, children] of Object.entries(expected)) {
    if (!children || typeof children !== "object" || Array.isArray(children)) throw new Error("Invalid Grok snapshot table.");
    for (const [name, value] of Object.entries(children)) {
      if (parent === "model" && name !== "archestra") throw new Error("Grok snapshot has an unknown managed model.");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Grok snapshot ownership.");
      tables.push({ parent, name, value });
    }
  }
  return tables;
}
const grokRoleKeys = ["default", "web_search", "session_summary", "image_description", "allowed_models"];
function grokMissingCredential(state) {
  if (!state.proxy) return null;
  if (state.nativeSession) return null;
  const model = readGrokToml(state.automatic?.template || state.block).model?.archestra;
  if (model?.extra_headers?.["X-Archestra-Grok-Credential-Mode"] === "native-session") return null;
  if (typeof model?.api_key === "string" && model.api_key.trim()) return null;
  const name = ["XAI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].includes(model?.env_key) ? model.env_key : "XAI_API_KEY";
  return process.env[name]?.trim() ? null : name;
}
function requireGrokCredential(state) {
  const name = grokMissingCredential(state);
  if (name) throw Object.assign(new Error("Set " + name + " in this terminal or choose a provider-backed personal virtual key. MCP login and skills are saved; MCP authorization does not supply an LLM API key. No native session was started."), { code: "GROK_CREDENTIAL_" + name });
}
function priorGrokRoles(state) {
  if (!state.modelRouting) return null;
  return (state.modelRouting.beforeSemantic ? readGrokToml(state.modelRouting.beforeSemantic).models : state.modelRouting.before ? readGrokToml(state.modelRouting.before).models : {}) || {};
}
const grokConsents = new Set();
function grokConflict({current, invariant, restore, expected}) {
  const scope = require("node:crypto").createHash("sha256").update(current).update(invariant).update(grokToml.stringify({ approved: expected ?? "" })).digest("hex");
  if (restore && grokConsents.has(scope)) { restore(); return; }
  const directory = path.join(require("node:os").homedir(), ".archestra", "grok", "conflict-" + require("node:crypto").randomUUID());
  grokPrivateDirectory(path.dirname(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  writeAtomic(path.join(directory, "config.toml"), current);
  const message = "Grok reconciliation needs local confirmation: " + invariant + ". Private backup: " + directory + ". No values or credentials are printed.";
  const headless = process.argv.some(arg => ["-p", "--single", "--prompt-file", "--prompt-json"].includes(arg) || /^--(?:sync|json|output-format)(?:=|$)/.test(arg));
  if (process.stderr.isTTY && restore && !headless) {
    let terminal = process.stdin.isTTY ? 0 : null;
    try {
      if (terminal === null && process.platform !== "win32") terminal = fs.openSync("/dev/tty", "r+");
      if (terminal !== null && require("node:tty").isatty(terminal)) {
        process.stderr.write(message + "\nRestore ONLY the previously approved managed values and retain all other settings? Type RESTORE to consent: ");
        let answer = "", buffer = Buffer.alloc(1);
        while (answer.length < 32 && fs.readSync(terminal, buffer, 0, 1, null) && buffer[0] !== 10) answer += buffer.toString();
        if (answer.trim() === "RESTORE") { grokConsents.add(scope); restore(); return; }
      }
    } catch {} finally { if (terminal !== null && terminal !== 0) fs.closeSync(terminal); }
  }
  throw new Error(message + " Run connection setup interactively to explicitly restore known managed values, or reconcile the named path locally. Noninteractive setup never overwrites a conflict.");
}
function withoutManagedConfig(current, state) {
  const document = readGrokToml(current), tables = ownedGrokTables(state);
  const beforeRoles = priorGrokRoles(state);
  const afterRoles = state.modelRouting ? readGrokToml(state.modelRouting.after).models : null;
  const present = tables.filter(({ parent, name }) => Object.hasOwn(document[parent] || {}, name));
  const beforePair = present.length === 0 && (tables.length > 0 || afterRoles) && (!afterRoles || grokRoleKeys.every(key => equalGrokValue(document.models?.[key], beforeRoles[key])));
  if (beforePair && state.format === undefined) return current;
  for (const { parent, name, value } of tables) {
    const actual = document[parent]?.[name];
    const extra = actual && Object.keys(actual).filter(key => !Object.hasOwn(value, key));
    if (extra?.some(key => !isGrokExtension(parent, key, actual[key]))) grokConflict({ current, invariant: "unowned fields inside " + parent + "." + name });
    if (!actual || Object.keys(value).some(key => !equalGrokValue(actual[key], value[key]))) grokConflict({ current, invariant: "owned-value-mismatch at " + parent + "." + name, expected: value, restore: () => { document[parent] ||= Object.create(null); document[parent][name] = { ...actual, ...value }; } });
    for (const key of Object.keys(value)) delete document[parent][name][key];
    if (!Object.keys(document[parent][name]).length) delete document[parent][name];
    if (!Object.keys(document[parent]).length) delete document[parent];
  }
  if (afterRoles) {
    for (const key of grokRoleKeys) {
      if (!equalGrokValue(document.models?.[key], afterRoles[key])) continue;
      if (Object.hasOwn(beforeRoles, key)) document.models[key] = beforeRoles[key];
      else delete document.models[key];
    }
    if (document.models && !Object.keys(document.models).length) delete document.models;
  }
  const end = "# END ARCHESTRA GROK CONNECTION\n", prefix = state.block.slice(0, -end.length);
  const start = current.indexOf(prefix), finish = current.indexOf(end, start + prefix.length);
  if (state.block.endsWith(end) && start >= 0 && finish >= 0 && start === current.lastIndexOf(prefix) && finish === current.lastIndexOf(end)) {
    let exact = current.slice(0, start) + current.slice(start + prefix.length, finish) + current.slice(finish + end.length);
    if (state.modelRouting) {
      const section = grokModelsSection(exact);
      if (section && section.text?.trimEnd() === state.modelRouting.after.trimEnd()) {
        const separator = state.modelRouting.separator || "";
        const remove = separator && exact.slice(section.start - separator.length, section.start) === separator ? separator.length : 0;
        exact = exact.slice(0, section.start - remove) + (state.modelRouting.before || "") + exact.slice(section.end);
      }
    }
    try { if (equalGrokValue(readGrokToml(exact), document)) return exact; } catch {}
  }
  const history = path.join(require("node:os").homedir(), ".archestra", "grok", "config-history");
  grokPrivateDirectory(history);
  const backup = path.join(history, require("node:crypto").createHash("sha256").update(current).digest("hex") + ".toml");
  if (grokFile(backup) === null) writeAtomic(backup, current);
  return grokToml.stringify(document);
}
function grokModelsSection(text) {
  if (text.includes('"""') || text.includes("'''")) return { start: text.length, end: text.length, text: null };
  const headers = [...text.matchAll(/^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:#[^\n]*)?\r?$/gm)];
  const index = headers.findIndex(match => /^(?:models|"models"|'models')$/.test(match[1].trim()));
  if (index < 0) return { start: text.length, end: text.length, text: null };
  const start = headers[index].index, end = headers[index + 1]?.index ?? text.length;
  return { start, end, text: text.slice(start, end) };
}
function configureGrokModelRouting(original) {
  const document = readGrokToml(original), beforeValues = document.models || {};
  let before = grokModelsSection(original).text;
  try { if (before && !equalGrokValue(readGrokToml(before).models, beforeValues)) before = null; } catch { before = null; }
  const after = grokToml.stringify({ models: { ...beforeValues, default: "archestra", web_search: "archestra", session_summary: "archestra", image_description: "archestra", allowed_models: ["archestra"] } });
  return { before, beforeSemantic: grokToml.stringify({ models: beforeValues }), separator: before === null && original && !original.endsWith("\n") ? "\n" : "", after };
}
function withGrokModelRouting(original, state) {
  if (!state.modelRouting) { readGrokToml(original); return original; }
  const document = readGrokToml(original), section = grokModelsSection(original);
  const after = readGrokToml(state.modelRouting.after).models;
  const updated = { ...document, models: { ...document.models, ...after } };
  const exact = original.slice(0, section.start) + (state.modelRouting.separator || "") + state.modelRouting.after + original.slice(section.end);
  try { if (equalGrokValue(readGrokToml(exact), updated)) return exact; } catch {}
  return grokToml.stringify(updated);
}
function isGrokExtension(parent, key, value) {
  if (parent === "model") {
    if (["description", "reasoning_effort"].includes(key)) return typeof value === "string";
    if (["supports_reasoning_effort", "stream_tool_calls"].includes(key)) return typeof value === "boolean";
    return ["temperature", "top_p", "max_completion_tokens", "context_window", "max_retries", "inference_idle_timeout_secs"].includes(key) && (typeof value === "number" || typeof value === "bigint");
  }
  return key === "enabled" ? typeof value === "boolean" : ["startup_timeout_sec", "tool_timeout_sec"].includes(key) && typeof value === "number";
}
function assertGrokAvailable(original, state, previous) {
  const document = readGrokToml(original);
  const reserved = [...ownedGrokTables(state).map(table => [table.parent, table.name]), ...(state.ownedTables || []).map(table => [table.slice(0, table.indexOf(".")), table.slice(table.indexOf(".") + 1)])];
  for (const [parent] of reserved) if (document[parent] !== undefined && (!document[parent] || typeof document[parent] !== "object" || Array.isArray(document[parent]) || document[parent] instanceof Date)) throw new Error("Grok already has an unmanaged or inline " + parent + " value; no settings were replaced.");
  for (const [parent, name] of reserved) if (Object.hasOwn(document[parent] || {}, name)) {
    const known = previous && ownedGrokTables(previous).some(table => table.parent === parent && table.name === name);
    if (!known || !Object.entries(document[parent][name]).every(([key, value]) => isGrokExtension(parent, key, value))) throw new Error("Grok already has an unmanaged or inline " + parent + "." + name + " table. No settings were replaced.");
  }
}
function assembleGrokConfig(original, state) {
  const routed = withGrokModelRouting(original, state), document = readGrokToml(routed), tables = ownedGrokTables(state);
  if (!tables.some(table => document[table.parent]?.[table.name])) return routed + state.block;
  for (const {parent, name, value} of tables) { document[parent] ||= Object.create(null); document[parent][name] = { ...document[parent][name], ...value }; }
  return grokToml.stringify(document);
}
`}`;
