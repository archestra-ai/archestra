# Insights from the examples

## Why `world` exists

`world` is an example convention, **not** a baton-core concept — an out-of-audience
recipient token (`demo.rs` uses `charlie`; the unit tests use `stranger` the same
way). It's needed because `Audience` is asymmetric:

- **Readers side** has built-in sentinels: `Audience::PUBLIC` and
  `Audience::UNKNOWN`.
- **Recipient side** (`ToolRequest::exposing`) has none. `recipients` is a plain
  `BTreeSet<UserId>`, and `covers` is literal set inclusion — no "everyone"
  token, no group expansion.

So there's no built-in way to say "this egress exposes to the public"; a real
egress reveals to a specific, enumerable set the harness must name. `world` is a
sentinel reader outside the source's audience, so the leak surfaces:

```
audience {alice@archestra.ai, bob@archestra.ai}  +  recipients {world}
    →  covers Fails  →  AudienceExceeds
```

Any out-of-audience string works. Just keep the vocabulary consistent on both
sides — real principals (`alice@archestra.ai`) for people, plus a sentinel like
`world` for "the public" — since `covers` compares tokens literally.

## The dimension set is hardcoded, not extensible

`Grant` — and `Label` and `Requirements` — are plain structs with **named,
concrete fields**, not generic over a dimension set:

```rust
struct Grant {
    trust:    Option<KnownTrust>,
    audience: Option<BTreeSet<UserId>>,
    effects:  Option<BTreeSet<Effect>>,
    confirms: bool,
}
```

No dimension registry, no `Vec<Dimension>`, no `dyn`. Every operation enumerates
the fields by hand — `covers` (`trust_ok && audience_ok && effects_ok &&
confirms_ok`), `Label::lift`, `Requirements::check`, `needed_grant`. The three
data dimensions are fixed instances of the generic `preset.rs` algebras:
`Audience(MeetSet<UserId>)`, `Trust(MinLevel<KnownTrust>)`,
`Effects(JoinSet<Effect>)`.

So the generality lives one layer down: `preset.rs` gives reusable algebra
*kinds* (`MeetSet`, `JoinSet`, `MinLevel`, `MaxLevel`), but the crate wires in a
fixed set of *instances*. Adding a new axis — a data-classification level
(`MaxLevel` is already there, "with no built-in instance yet"), or a
data-residency region — is **not** config or a new `Authority`; it's a core-type
edit touching `Label`, `Grant`, `Requirements`, and each hand-written per-field
fold.

That's a deliberate trade, not an oversight: because every operation `match`es
the fixed fields, a new dimension is a **compile error until it's handled
everywhere**, and the check's emission order stays observable. Exhaustiveness
and a stable order, bought at the cost of compile-time-fixed dimensions.
