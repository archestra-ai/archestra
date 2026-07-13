// Golden-corpus INPUT generator (deterministic). Writes the `name`/`rawContent`/
// `unwrap` fields of golden-corpus.json; the expected outputs are then filled in
// by the Rust side:
//   1. from platform/backend:
//      pnpm exec tsx ../archestra-rs/proxy-transform-core/tests/fixtures/gen-corpus.mts
//   2. from platform/archestra-rs:
//      UPDATE_TOON_GOLDENS=1 cargo test -p proxy_transform_core --test golden_corpus
//
// Raw contents for boundary numbers are hand-written strings so exact JSON
// literals survive (JS values would coerce before serialization). The bench
// items reuse the T0 benchmark corpus builder for realistic kernel shapes.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBatch } from "../../../../backend/src/routes/proxy/__bench__/corpus";

interface CorpusItem {
  name: string;
  rawContent: string;
  unwrap: boolean;
}

const TOOL_RESULT_DATA = {
  files: [
    { name: "README.md", size: 1024, type: "file" },
    { name: "src", size: 4096, type: "directory" },
    { name: "package.json", size: 512, type: "file" },
    { name: "tsconfig.json", size: 256, type: "file" },
    { name: "node_modules", size: 102400, type: "directory" },
  ],
  totalCount: 5,
  directory: ".",
};

const items: CorpusItem[] = [];
const add = (name: string, rawContent: string, unwrap = true) =>
  items.push({ name, rawContent, unwrap });

// --- ordering ---
add("order-integer-like-keys", '{"2":"two","10":"ten","a":1,"1":"one","b":{"20":true,"3":false,"x":null}}');
add("order-array-of-objs-mixed-keys", '[{"10":1,"2":2,"z":3},{"10":4,"2":5,"z":6}]');

// --- boundary numbers ---
add("num-2p53-minus1", '{"n":9007199254740991}');
add("num-2p53", '{"n":9007199254740992}');
add("num-2p53-plus1", '{"n":9007199254740993}');
add("num-neg-2p53-plus1", '{"n":-9007199254740993}');
add("num-i64-max", '{"n":9223372036854775807}');
add("num-i64-max-plus1", '{"n":9223372036854775808}');
add("num-i64-min", '{"n":-9223372036854775808}');
add("num-u64-max", '{"n":18446744073709551615}');
add("num-u64-max-plus1", '{"n":18446744073709551616}');
add("num-1e21-exp", '{"x":1e21}');
add("num-1e21-expanded", '{"x":1000000000000000000000}');
add("num-1e300", '{"x":1e300}');
add("num-neg-1e21", '{"x":-1e21}');
add("num-1e-7", '{"x":1e-7}');
add("num-1e-300", '{"x":1e-300}');
add("num-neg-zero", '{"x":-0}');
add("num-neg-zero-float", '{"x":-0.0}');
add("num-float-precision", '{"x":0.1,"y":1.005,"z":123.456e2}');
add("num-large-neg", '{"x":-1.7976931348623157e308}');

// --- escaping / unicode ---
add("esc-quotes-commas-colons", '{"a":"he said \\"hi, there\\": ok","b":"comma,separated","c":"colon: value","d":"[bracket] {brace}"}');
add("esc-control-chars", '{"a":"line1\\nline2\\ttabbed","b":"back\\\\slash","c":"nul\\u0000end","d":"\\u001b[31mred"}');
add("esc-toon-specials", '{"a":"  leading spaces","b":"trailing  ","c":"#comment-ish","d":"- dash start","e":"|pipe|","f":"true","g":"123","h":"null","i":""}');
add("unicode-mixed", '{"emoji":"🎉🚀 done","cjk":"日本語テスト","combining":"éé","rtl":"مرحبا","surrogate":"𝄞 music"}');

// --- nesting / roots ---
add("nested-deep", '{"a":{"b":{"c":{"d":{"e":[1,{"f":[true,null,{"g":"deep"}]}]}}}}}');
add("nested-mixed-arrays", '[[1,2],[3,[4,5]],{"k":[{"a":1},{"a":2}]}]');
add("root-string", '"just a string"');
add("root-number", "42");
add("root-float", "3.14");
add("root-true", "true");
add("root-null", "null");
add("root-array-scalars", "[1,2,3,4,5]");
add("root-array-strings", '["a","b","c with, comma"]');
add("empty-object", "{}");
add("empty-array", "[]");
add("array-of-empty-objects", "[{},{},{}]"); // encode-only golden: toon-format issue #74 (decoder rejects `[N]{}:`)
add("array-with-one-empty-object", '[{"a":1},{}]');

// --- malformed (must be skipped, encoded=null) ---
add("malformed-truncated", '{"a": [1, 2');
add("malformed-prose", "Tool run 42 output: alpha bravo charlie");
add("malformed-single-quotes", "{'a': 1}");
add("malformed-nan", '{"x": NaN}');
add("malformed-infinity", '{"x": Infinity}');
add("malformed-empty", "");

// --- wrappers ---
const inner = JSON.stringify({ data: [{ id: 1, v: "a" }, { id: 2, v: "b" }], ok: true });
add("wrapped-single-text", JSON.stringify([{ type: "text", text: inner }]));
add("wrapped-multi-text", JSON.stringify([
  { type: "text", text: inner },
  { type: "text", text: '{"second":"element ignored by unwrap"}' },
]));
add("wrapped-first-not-text", JSON.stringify([
  { type: "image", url: "http://x" },
  { type: "text", text: inner },
]));
add("wrapped-text-not-json", JSON.stringify([{ type: "text", text: "plain prose result" }]));
add("wrapped-but-unwrap-false", JSON.stringify([{ type: "text", text: inner }]), false);

// --- realistic provider payloads ---
add("provider-matrix-tool-result", JSON.stringify(TOOL_RESULT_DATA));
add("bedrock-json-branch", JSON.stringify(TOOL_RESULT_DATA), false);
add("realistic-github-issues", JSON.stringify({
  items: Array.from({ length: 12 }, (_, i) => ({
    number: 100 + i,
    title: `Issue title number ${i}: something broke, badly`,
    state: i % 3 === 0 ? "closed" : "open",
    user: { login: `user${i}`, id: 1000 + i },
    labels: [`bug`, `p${i % 3}`],
    comments: i * 2,
    created_at: `2026-06-${String(1 + i).padStart(2, "0")}T10:00:00Z`,
  })),
  total_count: 12,
}));
add("realistic-db-rows", JSON.stringify(
  Array.from({ length: 20 }, (_, i) => ({
    id: i,
    email: `person${i}@example.com`,
    balance: Math.round((i * 137.13 % 1000) * 100) / 100,
    active: i % 2 === 0,
    region: ["us-east", "eu-west", "ap-south"][i % 3],
  })),
));

// --- bench-corpus derived (realistic kernel shapes, deterministic seed) ---
for (const [i, benchItem] of buildBatch({ name: "1KB", payloadBytes: 1 << 10, count: 10 }, 42).entries()) {
  items.push({ name: `bench-1kb-${i}`, rawContent: benchItem.rawContent, unwrap: benchItem.unwrap });
}
for (const [i, benchItem] of buildBatch({ name: "10KB", payloadBytes: 10 << 10, count: 3 }, 7).entries()) {
  items.push({ name: `bench-10kb-${i}`, rawContent: benchItem.rawContent, unwrap: benchItem.unwrap });
}

// --- near-boundary family: engineered so TOON savings hover around zero.
// Heterogeneous keys + comma-laden strings kill the tabular win; sweep sizes
// so some land within ±2 tokens of the original.
for (let k = 1; k <= 10; k++) {
  const obj: Record<string, unknown> = {};
  for (let j = 0; j < k; j++) {
    obj[`key_${j}`] = j % 2 === 0 ? `val, with comma ${j}` : j * 1.5;
  }
  add(`boundary-obj-${k}`, JSON.stringify(obj));
}
for (let k = 1; k <= 6; k++) {
  const arr = Array.from({ length: k }, (_, j) => ({
    [`f${j}`]: `x,y ${j}`,
    n: j,
  }));
  add(`boundary-hetero-arr-${k}`, JSON.stringify(arr));
}

// Hyphenated values are quoted by the v3 encoder ('-' is structural), so the
// token savings sweep crosses zero around these sizes — near-boundary coverage
// for keep/reject decisions.
for (let k = 1; k <= 8; k++) {
  const arr = Array.from({ length: k }, (_, j) => ({
    sku: `AB-${100 + j}`,
    zone: `us-east-${j}`,
    n: j,
  }));
  add(`boundary-hyphen-arr-${k}`, JSON.stringify(arr));
}

// Finer sweep around the keep/reject crossing: 1-2 rows, mixing bare fields
// (savings source) and hyphenated fields (quoting penalty), varying counts so
// savings land at -1, 0, +1, +2 tokens.
for (let bare = 0; bare <= 4; bare++) {
  for (let hyph = 1; hyph <= 3; hyph++) {
    for (const rows of [1, 2]) {
      const arr = Array.from({ length: rows }, (_, r) => {
        const row: Record<string, unknown> = {};
        for (let j = 0; j < bare; j++) row[`b${j}`] = `plain${r}${j}`;
        for (let j = 0; j < hyph; j++) row[`h${j}`] = `us-east-${r}${j}`;
        return row;
      });
      add(`fine-r${rows}-b${bare}-h${hyph}`, JSON.stringify(arr));
    }
  }
}

const out =
  process.argv[2] ??
  join(dirname(fileURLToPath(import.meta.url)), "golden-corpus.json");
writeFileSync(out, `${JSON.stringify(items, null, 2)}\n`);
console.log(`wrote ${items.length} corpus items to ${out}`);
