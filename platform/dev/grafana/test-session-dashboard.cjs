// Exercise the shipped Grafana formatters and transformations, with synthetic data only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const modules = process.env.GRAFANA_CHECK_NODE_MODULES;
assert(modules, 'Set GRAFANA_CHECK_NODE_MODULES to the temporary Grafana test dependencies.');
const vendor = createRequire(path.join(path.resolve(modules), '_dashboard_test.cjs'));
const data = vendor('@grafana/data');
const { lastValueFrom } = vendor('rxjs');
// Load only the formatter module, avoiding unrelated browser UI components.
// This changes module syntax only; formatter implementations are unmodified.
const scenes = path.dirname(vendor.resolve('@grafana/scenes/package.json'));
let source = fs.readFileSync(path.join(scenes, 'dist/esm/variables/interpolation/formatRegistry.js'), 'utf8');
source = source.replace(/^import \{([^}]+)\} from '([^']+)';/gm, (_, names, pkg) => `const {${names}} = require('${pkg}');`)
  .replace(/^export \{[^}]+\};/gm, 'module.exports = { formatRegistry };');
const loaded = { exports: {} };
new Function('require', 'module', 'exports', source)(vendor, loaded, loaded.exports);
const { formatRegistry } = loaded.exports;
const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'dashboards/agent-sessions.json'), 'utf8'));
const table = board.panels.find(p => p.title === 'Recent Agent Sessions');
const logs = board.panels.find(p => p.title === 'Session Logs');
const trace = board.templating.list.find(v => v.name === 'traceId');
const values = { agent_name: 'Test "agent"', sessionId: 'session-a' };
const interpolate = query => query.replace(/\$\{(agent_name|sessionId):([^}]+)\}/g, (_, name, format) =>
  formatRegistry.get(format).formatter(values[name], [], { state: { name, type: 'textbox' }, getValue: () => values[name] }));

// A formatter that leaves scalar values unquoted makes these real LogQL string
// positions invalid. JSON.parse exercises escaping too, including embedded quotes.
assert.equal(JSON.parse(interpolate(table.targets[0].expr).match(/agent =~ (.+)$/)[1]), values.agent_name);
for (const query of [logs.targets[0].expr, trace.query.stream]) {
  const literal = interpolate(query).match(/session_id = ("(?:\\.|[^"\\])*")/)[1];
  assert.equal(JSON.parse(literal), values.sessionId);
}
console.log('PASS: table, logs and session-to-trace lookup use valid quoted filter values');

for (const transformer of Object.values(data.standardTransformers)) {
  if (!data.standardTransformersRegistry.getIfExists(transformer.id)) {
    data.standardTransformersRegistry.register({ id: transformer.id, name: transformer.name, transformation: () => transformer });
  }
}
global.window = {}; // The data library checks the scenes flag; no UI is rendered.
const snapshots = [
  { session_id: 'session-a', agent_type: 'agent', last_request: '2026-01-01T12:00:00Z', requests: 2, estimated_cost: .3 },
  { session_id: 'session-b', agent_type: 'agent', last_request: '2026-01-01T12:30:00Z', requests: 1, estimated_cost: 2 },
  { session_id: 'session-a', agent_type: 'agent', last_request: '2026-01-01T13:00:00Z', requests: 3, estimated_cost: .5 },
  { session_id: 'session-a', agent_type: 'agent', last_request: '2026-01-01T13:00:00Z', requests: 2, estimated_cost: .4 },
];
// JSON extraction is independently checked by the dashboard query; exercise
// the actual grouping/ordering with the parsed JSON values it supplies.
lastValueFrom(data.transformDataFrame(table.transformations.filter(t => t.id !== 'extractFields'), [data.toDataFrame(snapshots)]))
  .then(([frame]) => {
    const rows = Array.from({ length: frame.length }, (_, i) => Object.fromEntries(frame.fields.map(f => [f.name.replace(' (firstNotNull)', ''), f.values[i]])));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].session_id, 'session-a');
    assert.equal(rows[0].requests, 3);
    assert.equal(rows[0].estimated_cost, .5);
    assert(!frame.fields.some(f => f.name.startsWith('agent_type')));
    console.log('PASS: one latest coherent row per session, no duplicate cost totals, correct ordering, and no Agent type column');
  }).catch(error => { console.error(error); process.exitCode = 1; });
