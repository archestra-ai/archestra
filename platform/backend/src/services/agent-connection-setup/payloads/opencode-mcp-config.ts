import type { OpenCodeFamilyClient } from "../opencode-family";

/** Persist cfg before calling writeMcpSibling(), so a failed write keeps the old connection. */
export function openCodeMcpMergeScript(
  client: OpenCodeFamilyClient,
  mode: "connect" | "disconnect" | "verify" | "repair" = "connect",
): string {
  return String.raw`
let writeMcpSibling = () => {};
if (process.env.ARCHESTRA_OC_MCP_NAME) {
  let name = process.env.ARCHESTRA_OC_MCP_NAME;
  let url = process.env.ARCHESTRA_OC_MCP_URL;
  const mode = ${JSON.stringify(mode)};
  const disabledField = mode === "repair" && process.env.ARCHESTRA_OC_MCP_DISABLED_FIELD === "disabled" ? "disabled" : "enabled";
  const isDisabled = entry => entry?.enabled === false || (disabledField === "disabled" && entry?.disabled === true);
  const siblingPath = path.join(path.dirname(configPath), ${JSON.stringify(client.commentedConfigFile)});
  const raw = fs.existsSync(siblingPath) ? fs.readFileSync(siblingPath, "utf8") : "";
  // Token positions let us change only enabled flags, leaving JSONC comments,
  // trailing commas and all of the user's connection settings intact.
  const tokens = [...raw.matchAll(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|\s+|[{}\[\],:]|[^\s{}\[\],:]+/g)]
    .filter(match => !/^\s|^\/\//.test(match[0]) && !match[0].startsWith("/*"))
    .map(match => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
  const sibling = tokens.length ? JSON.parse(tokens.filter((token, i) => token.text !== "," || !["}", "]"].includes(tokens[i + 1]?.text)).map(token => token.text).join("")) : {};
  const properties = (start) => {
    if (tokens[start]?.text !== "{") return [];
    const found = [];
    let i = start + 1;
    while (tokens[i]?.text !== "}") {
      const key = JSON.parse(tokens[i].text);
      const value = i + 2;
      i = value;
      if (["{", "["].includes(tokens[i].text)) {
        let depth = 0;
        do {
          if (["{", "["].includes(tokens[i].text)) depth++;
          if (["}", "]"].includes(tokens[i].text)) depth--;
          i++;
        } while (depth > 0);
      } else i++;
      found.push({ key, value, end: i - 1 });
      if (tokens[i]?.text === ",") i++;
    }
    return found;
  };
  const mcp = properties(0).filter(property => property.key === "mcp");
  if (mcp.length > 1) throw new Error("Duplicate mcp sections in " + siblingPath + "; consolidate them before connecting.");
  const entries = mcp.length ? properties(mcp[0].value) : [];
  if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw new Error("Duplicate MCP names in " + siblingPath + "; consolidate them before connecting.");
  if (mode !== "repair") cfg.mcp ??= {};
  const sameGateway = entry => entry?.type === "remote" && entry.url === url;
  const settings = {};
  const mergeSettings = (target, source, override = false) => {
    for (const [key, value] of Object.entries(source)) {
      if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
      else if (target[key] && value && typeof target[key] === "object" && typeof value === "object" && !Array.isArray(target[key]) && !Array.isArray(value)) mergeSettings(target[key], value, override);
      else if (override) target[key] = value;
      else if (JSON.stringify(target[key]) !== JSON.stringify(value)) throw new Error("Conflicting MCP connection settings for " + name + "; consolidate the gateway registrations before connecting.");
    }
  };
  // The sibling wins overlapping fields, just as it does in the client. A
  // partial entry such as { enabled: false } still overrides a JSON registration.
  const effective = JSON.parse(JSON.stringify(cfg.mcp ?? {}));
  mergeSettings(effective, sibling.mcp ?? {}, true);
  // Startup may keep an existing alias, but never creates/re-enables a deleted
  // or deliberately disabled canonical binding from an old registration.
  if (mode === "repair" && (!sameGateway(effective[name]) || isDisabled(effective[name]))) {
    name = Object.entries(effective).find(([, entry]) => sameGateway(entry) && !isDisabled(entry))?.[0];
  }
  if (mode !== "repair" || (name && Object.values(effective).filter(entry => sameGateway(entry) && !isDisabled(entry)).length > 1)) {
  cfg.mcp ??= {};
  const connecting = mode === "connect" || mode === "repair";
  if (mode !== "connect") url ||= effective[name]?.url;
  if (mode === "verify") process.exit(Object.entries(effective).some(([alias, entry]) => entry?.enabled !== false && (alias === name || (url && sameGateway(entry)))) ? 1 : 0);
  if (mode === "connect" && sibling.mcp?.[name] && effective[name]?.url && !sameGateway(effective[name])) throw new Error("MCP name " + name + " is already used by another endpoint in " + siblingPath + ". Choose a different gateway name before connecting.");
  const edits = [];
  for (const [alias, entry] of Object.entries(effective)) {
    if (!connecting || !sameGateway(entry) || (isDisabled(entry) && alias !== name)) continue;
    const { enabled, ...options } = entry;
    if (disabledField === "disabled") delete options.disabled;
    mergeSettings(settings, options);
  }
  for (const property of entries) {
    if (property.key === name && tokens[property.value].text !== "{") throw new Error("Invalid MCP connection in " + siblingPath + "; use a configuration object before connecting.");
    const entry = effective[property.key];
    if (property.key !== name && (!sameGateway(entry) || isDisabled(entry))) continue;
    const enabled = connecting && property.key === name;
    if (property.key === name && connecting && !isDisabled(entry)) continue;
    if (!enabled && isDisabled(entry)) continue;
    const fields = properties(property.value);
    if (new Set(fields.map(field => field.key)).size !== fields.length) throw new Error("Duplicate MCP connection fields in " + siblingPath + "; consolidate them before connecting.");
    const flag = fields.find(field => field.key === disabledField);
    const flagValue = disabledField === "disabled" ? !enabled : enabled;
    edits.push(flag
      ? { start: tokens[flag.value].start, end: tokens[flag.end].end, text: String(flagValue) }
      : { start: tokens[property.value].end, end: tokens[property.value].end, text: JSON.stringify(disabledField) + ":" + flagValue + (fields.length ? "," : "") });
  }
  for (const [alias, entry] of Object.entries(effective)) {
    if ((alias !== name || mode === "disconnect") && sameGateway(entry) && (mode !== "repair" || !isDisabled(entry))) delete cfg.mcp[alias];
  }
  if (connecting) Object.defineProperty(cfg.mcp, name, { value: { ...settings, type: "remote", url, ...(effective[name]?.enabled !== undefined ? { enabled: true } : {}), ...(disabledField === "disabled" && effective[name]?.disabled !== undefined ? { disabled: false } : {}) }, writable: true, configurable: true, enumerable: true });
  else delete cfg.mcp[name];
  if (!Object.keys(cfg.mcp).length) delete cfg.mcp;
  if (edits.length) {
    let updated = raw;
    for (const edit of edits.sort((a, b) => b.start - a.start)) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
    writeMcpSibling = () => {
      const backup = siblingPath + ".archestra-backup";
      if (!fs.existsSync(backup)) fs.copyFileSync(siblingPath, backup);
      fs.writeFileSync(siblingPath, updated);
      console.log("Updated " + siblingPath + " (consolidated gateway aliases)");
    };
  }
  }
}
`;
}
