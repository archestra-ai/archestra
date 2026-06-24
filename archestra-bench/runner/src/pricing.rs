//! Per-run cost pricing sourced from OpenRouter's public model list. A [`PriceBook`] maps an
//! OpenRouter model slug to its per-token USD prices; [`PriceBook::cost`] turns a run's token split
//! into a dollar figure. Fetching (network) is kept separate from parsing so the parser and the cost
//! math are unit-tested without HTTP. A slug we cannot price yields `None`, never a fabricated `0`.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value as JsonValue;

const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";

/// Per-token USD prices for one model. `cache_read` is the discounted rate for cached prompt tokens,
/// absent when OpenRouter publishes none (the caller then prices cache reads at the normal input rate).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct PriceBook {
    models: HashMap<String, ModelPrice>,
}

impl PriceBook {
    pub fn get(&self, slug: &str) -> Option<&ModelPrice> {
        self.models.get(slug)
    }

    /// USD cost of one run. `None` — reported as `n/a`, never `0` — when the lane has no slug, the slug
    /// is absent from the book, or token counts are missing.
    ///
    /// `prompt` is the backend's `inputTokens`, which is already **net of** cache reads (the platform
    /// emits a fully-cached request as `inputTokens == 0`, with the cache shown separately — see
    /// `calculateCost` in the platform's cost-optimization). So input and cache tokens are disjoint and
    /// summed, not subtracted. Cache reads are billed at the cache rate when OpenRouter publishes one,
    /// else at the input rate (the conservative estimate when the discount is unknown).
    pub fn cost(
        &self,
        prompt: Option<i64>,
        completion: Option<i64>,
        cache_read: Option<i64>,
        slug: Option<&str>,
    ) -> Option<f64> {
        let price = self.models.get(slug?)?;
        let prompt = prompt?.max(0) as f64;
        let completion = completion?.max(0) as f64;
        let cache_read = cache_read.unwrap_or(0).max(0) as f64;
        let cache_price = price.cache_read.unwrap_or(price.input);
        Some(prompt * price.input + cache_read * cache_price + completion * price.output)
    }
}

/// Fetch and parse OpenRouter's model list. Any failure is returned as an error string so the caller
/// can record the fetch status once and fall back to an empty book (all costs `n/a`).
pub async fn fetch_price_book() -> Result<PriceBook, String> {
    // Bounded so a hung models endpoint can't stall the whole benchmark before any rollout starts.
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = http
        .get(OPENROUTER_MODELS_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let json: JsonValue = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parse_price_book(&json))
}

/// Build a [`PriceBook`] from OpenRouter's `/models` payload. A model is included only when both
/// `prompt` and `completion` parse to a non-negative per-token price; a `-1` (dynamic-router) or
/// missing price drops the model so it reports as unknown rather than free.
pub fn parse_price_book(models_json: &JsonValue) -> PriceBook {
    let mut models = HashMap::new();
    let Some(data) = models_json.get("data").and_then(|v| v.as_array()) else {
        return PriceBook { models };
    };
    for model in data {
        let Some(id) = model.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let pricing = model.get("pricing");
        let field = |key: &str| pricing.and_then(|p| price_field(p.get(key)));
        if let (Some(input), Some(output)) = (field("prompt"), field("completion")) {
            models.insert(
                id.to_string(),
                ModelPrice {
                    input,
                    output,
                    cache_read: field("input_cache_read"),
                },
            );
        }
    }
    PriceBook { models }
}

/// OpenRouter quotes per-token USD as decimal strings; `"0"` is genuinely free, `"-1"` marks a dynamic
/// router with no fixed price. Treat anything missing, unparseable, or negative as no price.
fn price_field(value: Option<&JsonValue>) -> Option<f64> {
    value?.as_str()?.parse::<f64>().ok().filter(|p| *p >= 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> PriceBook {
        parse_price_book(&serde_json::json!({
            "data": [
                { "id": "vendor/cheap", "pricing": { "prompt": "0.000001", "completion": "0.000002" } },
                { "id": "vendor/cached", "pricing": {
                    "prompt": "0.000001", "completion": "0.000002", "input_cache_read": "0.0000001" } },
                { "id": "vendor/free", "pricing": { "prompt": "0", "completion": "0" } },
                { "id": "vendor/dynamic", "pricing": { "prompt": "-1", "completion": "-1" } },
                { "id": "vendor/partial", "pricing": { "prompt": "0.000001" } },
            ]
        }))
    }

    #[test]
    fn parse_keeps_priced_models_and_drops_unpriced() {
        let book = book();
        assert!(book.get("vendor/cheap").is_some());
        assert!(book.get("vendor/free").is_some()); // free is a real 0 price
        assert!(book.get("vendor/dynamic").is_none()); // -1 dynamic router → unknown
        assert!(book.get("vendor/partial").is_none()); // missing completion → unknown
        assert_eq!(
            book.get("vendor/cached").unwrap().cache_read,
            Some(0.0000001)
        );
        assert_eq!(book.get("vendor/cheap").unwrap().cache_read, None);
    }

    #[test]
    fn cost_uses_input_and_output_rates() {
        let book = book();
        // 1000 input * 1e-6 + 500 output * 2e-6 = 0.001 + 0.001
        let cost = book.cost(Some(1000), Some(500), None, Some("vendor/cheap"));
        assert_eq!(cost, Some(0.002));
    }

    #[test]
    fn cost_adds_cache_reads_at_cache_rate() {
        let book = book();
        // input (1000) is already net of cache; cache reads (200) are disjoint and priced separately:
        // 1000*1e-6 + 200*1e-7 + 500*2e-6
        let cost = book
            .cost(Some(1000), Some(500), Some(200), Some("vendor/cached"))
            .unwrap();
        assert!((cost - (0.001 + 0.00002 + 0.001)).abs() < 1e-12);
    }

    #[test]
    fn cache_reads_without_rate_priced_at_input() {
        let book = book();
        // vendor/cheap has no cache rate → cache reads billed at the input rate, added on top of input.
        let with_cache = book
            .cost(Some(1000), Some(500), Some(300), Some("vendor/cheap"))
            .unwrap();
        // 1000*1e-6 + 300*1e-6 + 500*2e-6
        assert!((with_cache - (0.001 + 0.0003 + 0.001)).abs() < 1e-12);
    }

    #[test]
    fn negative_token_counts_clamp_to_zero() {
        let book = book();
        // A malformed negative count must not produce a negative cost.
        let cost = book
            .cost(Some(-5), Some(-5), Some(-5), Some("vendor/cached"))
            .unwrap();
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn unknown_slug_or_missing_tokens_is_none() {
        let book = book();
        assert_eq!(book.cost(Some(10), Some(10), None, Some("nope")), None);
        assert_eq!(book.cost(Some(10), Some(10), None, None), None);
        assert_eq!(book.cost(None, Some(10), None, Some("vendor/cheap")), None);
        assert_eq!(book.cost(Some(10), None, None, Some("vendor/cheap")), None);
    }
}
