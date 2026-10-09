import { DROID_PROVIDER_ROUTES } from "@archestra/shared/droid-provider-routes";
import { DEFAULT_MODELS } from "@archestra/shared/model-constants";
import { renderNodeSetupScript } from "../node-runner";
import { starterPrompt } from "../steps/ending";
import type { SetupScriptContext } from "../types";

// Factory's BYOK, MCP and skills docs:
// https://docs.factory.com/model-independence/byok
// https://docs.factory.com/harness/mcp
// https://docs.factory.com/harness/skills
// The installed Droid CLI also accepts explicit custom: IDs, avoiding array
// position-dependent IDs when a user adds another custom model.
const DROID_SETUP_SOURCE = `const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ctx = JSON.parse(Buffer.from(process.env.ARCHESTRA_NODE_SETUP_CONTEXT, 'base64').toString('utf8'));
delete process.env.ARCHESTRA_NODE_SETUP_CONTEXT;
const home = process.env.FACTORY_HOME_OVERRIDE || os.homedir();
const root = path.join(home, '.factory');
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
function readJson(file) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  let value;
  try { value = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error('Invalid JSON in ' + file); }
  if (!isObject(value)) throw new Error('Expected a JSON object in ' + file);
  return value;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(file + '.archestra-backup')) {
    fs.copyFileSync(file, file + '.archestra-backup');
    fs.chmodSync(file + '.archestra-backup', 0o600);
  }
  const temp = file + '.archestra-tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\\n', { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  console.log('Updated ' + file);
}
function childName(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value) || value === '.' || value === '..') throw new Error('Invalid managed folder name');
  return value;
}
// Parse and validate both files before writing either. Invalid user config
// must fail visibly, without replacing it or leaving half of a setup behind.
const mcpPath = path.join(root, 'mcp.json');
const settingsPath = path.join(root, 'settings.json');
const mcp = ctx.mcp ? readJson(mcpPath) : null;
const settings = ctx.proxy ? readJson(settingsPath) : null;
const statePath = path.join(home, '.archestra', 'droid-connection-state.json');
const state = ctx.proxy ? readJson(statePath) : null;
const handoffPath = path.join(root, 'skills', 'archestra-runtime-handoff', 'SKILL.md');
const handoffMarker = '<!-- archestra-managed-runtime-handoff -->';
if (ctx.mcp && ctx.runtimeHandoffInstructions && fs.existsSync(handoffPath) && !fs.readFileSync(handoffPath, 'utf8').includes(handoffMarker)) {
  throw new Error('The runtime handoff skill folder already belongs to another skill');
}
if (mcp) {
  if (mcp.mcpServers !== undefined && !isObject(mcp.mcpServers)) throw new Error('mcpServers must be an object');
  mcp.mcpServers ??= {};
  for (const legacy of ctx.mcp.legacyServerNames || []) {
    if (legacy !== ctx.mcp.serverName) delete mcp.mcpServers[legacy];
  }
  Object.defineProperty(mcp.mcpServers, ctx.mcp.serverName, { value: { type: 'http', url: ctx.mcp.url, disabled: false }, enumerable: true, configurable: true, writable: true });
}
if (settings) {
  const proxy = ctx.proxy;
  if (settings.customModels !== undefined && !Array.isArray(settings.customModels)) throw new Error('customModels must be an array');
  settings.customModels ??= [];
  if (settings.sessionDefaultSettings !== undefined && !isObject(settings.sessionDefaultSettings)) throw new Error('sessionDefaultSettings must be an object');
  settings.sessionDefaultSettings ??= {};
  const id = 'custom:archestra-' + childName(proxy.proxyName);
  const previous = settings.customModels.find(entry => entry.id === id);
  // Never take a Factory subscription token from its auth storage. BYOK uses
  // a provider key from a matching local custom model or the provider env var.
  const local = settings.customModels.find(entry => {
    if (entry.id === id || entry.model !== proxy.model || entry.provider !== proxy.dialect) return false;
    try { return proxy.credentialHosts.includes(new URL(entry.baseUrl).hostname); } catch { return false; }
  });
  const credential = proxy.authMode === 'virtual-key'
    ? proxy.virtualKey
    : local?.apiKey || (state.connections?.[id]?.authMode === 'provider-key' && state.connections[id].provider === proxy.provider ? previous?.apiKey : null) || proxy.credentialEnvs.map(name => process.env[name]).find(Boolean);
  if (!credential && proxy.provider !== 'ollama' && proxy.provider !== 'vllm') {
    throw new Error('Set ' + proxy.credentialEnvs.join(' or ') + ' in this terminal, or configure a matching BYOK model in Droid, then retry. To use a provider key stored in ' + ctx.appName + ', choose Virtual key on the connection page and run setup again.');
  }
  const entry = {
    id,
    model: proxy.model,
    displayName: ctx.appName + ' — ' + proxy.model,
    provider: proxy.dialect,
    baseUrl: proxy.url,
    ...(credential ? { apiKey: credential } : {}),
    extraHeaders: { 'X-Archestra-Agent-Id': 'droid' },
  };
  state.connections ??= {};
  state.connections[id] ??= {
    previousModel: previous ?? null,
    modelPresent: Object.hasOwn(settings.sessionDefaultSettings, 'model'),
    model: settings.sessionDefaultSettings.model,
    specModelPresent: Object.hasOwn(settings.sessionDefaultSettings, 'specModeModel'),
    specModel: settings.sessionDefaultSettings.specModeModel,
  };
  state.connections[id].authMode = proxy.authMode;
  state.connections[id].provider = proxy.provider;
  const index = settings.customModels.findIndex(entry => entry.id === id);
  if (index < 0) settings.customModels.push(entry);
  else settings.customModels[index] = entry;
  settings.sessionDefaultSettings.model = id;
  settings.sessionDefaultSettings.specModeModel = id;
  // Explicit mission/subagent routes are the user's choices. Unspecified
  // routes inherit this session model; never replace their other settings.
}
if (ctx.skills) {
  if (ctx.skills.pluginNames?.length) throw new Error('Droid plugin delivery is not supported by this marketplace');
  const folder = path.join(root, 'skills', childName(ctx.skills.marketplaceName));
  const git = args => {
    try { return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { throw new Error('Could not fetch Droid skills. Check Git access and retry.'); }
  };
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  if (fs.existsSync(path.join(folder, '.git'))) {
    // Refuse to take over an unrelated repository at the same path.
    const previousUrl = git(['-C', folder, 'remote', 'get-url', 'origin']).toString().trim();
    if (previousUrl !== ctx.skills.cloneUrl) {
      let sameMarketplace = false;
      try {
        const oldSource = new URL(previousUrl);
        const newSource = new URL(ctx.skills.cloneUrl);
        sameMarketplace = oldSource.origin === newSource.origin && oldSource.pathname.startsWith('/skills/') && newSource.pathname.startsWith('/skills/');
      } catch {}
      if (!sameMarketplace) throw new Error('The Droid skills folder belongs to another repository');
      git(['-C', folder, 'remote', 'set-url', 'origin', ctx.skills.cloneUrl]);
    }
    git(['-C', folder, 'pull', '--ff-only', '-q']);
  } else if (fs.existsSync(folder)) {
    throw new Error('The Droid skills folder already exists and is not a Git repository');
  } else {
    git(['clone', '-q', '--', ctx.skills.cloneUrl, folder]);
  }
  console.log('Installed Droid skills in ' + folder);
}
if (mcp) writeJson(mcpPath, mcp);
if (ctx.mcp && ctx.runtimeHandoffInstructions) {
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  fs.writeFileSync(handoffPath, '---\\nname: archestra-runtime-handoff\\ndescription: Delegate work to remote agents through the connected gateway. Use when a task benefits from remote execution.\\n---\\n' + handoffMarker + '\\nGateway: ' + ctx.mcp.url + '\\n\\n' + ctx.runtimeHandoffInstructions + '\\n', { mode: 0o600 });
  console.log('Installed runtime handoff instructions as a Droid skill');
}
if (settings) {
  writeJson(statePath, state);
  writeJson(settingsPath, settings);
}
`;

export function renderDroidSetupScript(ctx: SetupScriptContext): string {
  const route = ctx.proxy
    ? DROID_PROVIDER_ROUTES.find(
        (route) => route.provider === ctx.proxy?.provider,
      )
    : null;
  if (ctx.proxy && !route) throw new Error("Unsupported Droid provider");
  const enriched = {
    ...ctx,
    proxy:
      ctx.proxy && route
        ? {
            ...ctx.proxy,
            model: ctx.proxy.model ?? DEFAULT_MODELS[ctx.proxy.provider],
            url: ctx.proxy.url.replace(/\/$/, ""),
            dialect: route.dialect,
            credentialEnvs: route.credentialEnvs,
            credentialHosts: route.credentialHosts,
          }
        : null,
  };
  return renderNodeSetupScript(enriched, {
    label: "Droid",
    binary: "droid",
    source: DROID_SETUP_SOURCE,
    ending: {
      proxyDetail:
        "Custom model in ~/.factory/settings.json, selected for new Auto and Spec sessions",
      signIn: ctx.mcp
        ? {
            command: null,
            howTo: `In Droid, run /mcp and sign in to "${ctx.mcp.serverName}".`,
          }
        : null,
      launch: ["droid", starterPrompt(ctx)],
      notes: [
        "Start a new Droid session to load the configuration. Project or managed settings may override your user defaults; check /model and /diagnostics.",
        ...(ctx.skills
          ? ["Run /skills to confirm the shared skills are available."]
          : []),
        ...(ctx.mcp && ctx.runtimeHandoffInstructions
          ? [
              "Runtime handoff instructions are available as the archestra-runtime-handoff skill.",
            ]
          : []),
      ],
    },
  });
}
