# Cost Chart Benchmark

Source: `src/app/llm/(costs)/costs.utils.bench.ts`

| Case | Mean ms | p75 ms | p99 ms | Hz | Samples | RME |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| old find transform | 74.82 | 75.87 | 98.83 | 13.37 | 10 | 8.90% |
| new Map transform | 4.01 | 4.65 | 6.75 | 249.35 | 127 | 5.39% |

Speedup: **18.66x**

Raw JSON: `costs.utils.bench.json`
