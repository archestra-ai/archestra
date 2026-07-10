//! Diagnostic Criterion bench for the pure TOON kernel (no NAPI boundary).
//! The pre-registered performance threshold is measured by the JS harness
//! (`platform/backend/src/routes/proxy/__bench__/`); this bench isolates the
//! Rust-side cost per payload size on the same synthetic shapes as that
//! harness's corpus builder (uniform SKU rows / nested objects / prose, with
//! text-block wrappers and Bedrock-style `unwrap: false` items mixed in).

use criterion::{
    BatchSize, BenchmarkId, Criterion, Throughput, black_box, criterion_group, criterion_main,
};
use proxy_transform_core::{ToonEncodeItem, toon_encode_tool_results};
use serde_json::{Value, json};

/// (label, payload bytes) per corpus; every corpus is a 10-item batch covering
/// one full mix cycle of the JS corpus builder.
const PAYLOAD_SIZES: [(&str, usize); 4] = [
    ("1KB", 1 << 10),
    ("10KB", 10 << 10),
    ("100KB", 100 << 10),
    ("1MB", 1 << 20),
];
const ITEMS_PER_BATCH: usize = 10;

fn build_batch(payload_bytes: usize, seed: u64) -> Vec<ToonEncodeItem> {
    let mut rng = TinyRng::new(seed);
    (0..ITEMS_PER_BATCH)
        .map(|i| {
            // Same mix cycle as corpus.ts: per 10 items, 6 uniform arrays,
            // 2 non-array objects, 2 non-JSON prose; 2 JSON items wrapped in
            // the `[{"type":"text","text":...}]` client wrapper.
            let kind = match i % 10 {
                2 | 7 => PayloadKind::Object,
                4 | 9 => PayloadKind::NonJson,
                _ => PayloadKind::Array,
            };
            let wrapped = !matches!(kind, PayloadKind::NonJson) && matches!(i % 10, 6 | 7);
            let mut payload = build_payload(kind, payload_bytes, &mut rng);
            if wrapped {
                payload = serde_json::to_string(&json!([{ "type": "text", "text": payload }]))
                    .expect("wrapper serializes");
            }
            ToonEncodeItem {
                id: format!("bench_{i}"),
                raw_content: payload,
                unwrap: if wrapped { true } else { i % 7 != 3 },
            }
        })
        .collect()
}

enum PayloadKind {
    Array,
    Object,
    NonJson,
}

const WORDS: [&str; 12] = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
    "kilo", "lima",
];
const STATUSES: [&str; 4] = ["active", "pending", "archived", "failed"];

fn make_row(rng: &mut TinyRng, id: usize) -> Value {
    json!({
        "id": id,
        "sku": format!("SKU-{}", rng.below(1_000_000)),
        "name": format!("{} {}", WORDS[rng.below(WORDS.len())], WORDS[rng.below(WORDS.len())]),
        "status": STATUSES[rng.below(STATUSES.len())],
        "score": (rng.below(10_000) as f64) / 100.0,
        "quantity": rng.below(500),
        "active": rng.below(2) == 0,
        "updatedAt": format!("2026-0{}-{:02}T12:00:00Z", 1 + rng.below(6), 1 + rng.below(28)),
    })
}

fn build_payload(kind: PayloadKind, target_bytes: usize, rng: &mut TinyRng) -> String {
    match kind {
        PayloadKind::Array => {
            let mut rows = Vec::new();
            let mut size = 2;
            let mut id = 0;
            while size < target_bytes {
                let row = make_row(rng, id);
                id += 1;
                size += serde_json::to_string(&row).expect("row serializes").len() + 1;
                rows.push(row);
            }
            serde_json::to_string(&Value::Array(rows)).expect("array serializes")
        }
        PayloadKind::Object => {
            let mut entries = serde_json::Map::new();
            let mut size = 64;
            let mut id = 0;
            while size < target_bytes {
                let key = format!("entry_{id}");
                let mut value = make_row(rng, id);
                value["nested"] = json!({
                    "tags": [WORDS[rng.below(WORDS.len())], WORDS[rng.below(WORDS.len())]],
                    "depth": 2,
                });
                size += serde_json::to_string(&value)
                    .expect("entry serializes")
                    .len()
                    + key.len()
                    + 4;
                entries.insert(key, value);
                id += 1;
            }
            serde_json::to_string(&json!({
                "meta": { "source": "bench", "version": 3, "total": id },
                "entries": entries,
            }))
            .expect("object serializes")
        }
        PayloadKind::NonJson => {
            let mut parts = vec![format!("Tool run {} output:", rng.below(1000))];
            let mut size = parts[0].len();
            while size < target_bytes {
                let word = WORDS[rng.below(WORDS.len())];
                size += word.len() + 1;
                parts.push(word.to_string());
            }
            parts.join(" ")
        }
    }
}

fn bench_toon_kernel(c: &mut Criterion) {
    let mut group = c.benchmark_group("toon_kernel");
    group.sample_size(20);
    for (label, payload_bytes) in PAYLOAD_SIZES {
        let batch = build_batch(payload_bytes, 0x5eed ^ payload_bytes as u64);
        let total_bytes: usize = batch.iter().map(|item| item.raw_content.len()).sum();
        group.throughput(Throughput::Bytes(total_bytes as u64));
        group.bench_with_input(BenchmarkId::from_parameter(label), &batch, |b, batch| {
            b.iter_batched(
                || batch.clone(),
                |items| black_box(toon_encode_tool_results(black_box(items))),
                BatchSize::LargeInput,
            );
        });
    }
    group.finish();
}

#[derive(Clone, Copy)]
struct TinyRng(u64);

impl TinyRng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        self.0
    }

    fn below(&mut self, upper: usize) -> usize {
        ((self.next() >> 16) as usize) % upper
    }
}

criterion_group!(benches, bench_toon_kernel);
criterion_main!(benches);
