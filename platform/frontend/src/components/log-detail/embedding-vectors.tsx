import { useMemo } from "react";

/** The `data-embedding` part a logged embeddings call maps to. */
export type EmbeddingPartData = {
  count: number;
  dimensions: number;
  vectors: Array<{ label?: string; values: number[] }>;
};

/**
 * What an embeddings call returned. Each vector is a strip across its
 * dimensions: a bar above the line is a positive value, below a negative one.
 * A batch draws one strip per input under the input's text, so inputs that
 * mean the same thing look alike. The numbers stay in the Response view.
 */
export function EmbeddingVectors({ data }: { data: EmbeddingPartData }) {
  const hidden = data.count - data.vectors.length;
  const dimensions = data.dimensions.toLocaleString("en-US");
  const headline =
    data.count === 1 ? "1 embedding" : `${data.count} embeddings`;
  const detail = `${dimensions} dimensions${data.count > 1 ? " each" : ""}`;
  const more =
    hidden === 1
      ? "1 more embedding is in the Response view."
      : `${hidden} more embeddings are in the Response view.`;
  return (
    <div className="w-full max-w-xl space-y-3 rounded-lg border px-4 py-3">
      <p className="text-sm tabular-nums">
        <span className="font-medium">{headline}</span>
        <span className="text-muted-foreground"> · {detail}</span>
      </p>
      <div className="space-y-2">
        {data.vectors.map((vector, index) => (
          <figure
            // Vectors have no id; their order is the response's order.
            // biome-ignore lint/suspicious/noArrayIndexKey: stable order
            key={index}
            className="space-y-1"
          >
            {vector.label ? (
              <figcaption
                className="truncate text-xs text-muted-foreground"
                title={vector.label}
              >
                {vector.label}
              </figcaption>
            ) : null}
            <VectorStrip values={vector.values} />
          </figure>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="flex justify-between text-[11px] leading-4 text-muted-foreground tabular-nums"
      >
        <span>1</span>
        <span>{dimensions}</span>
      </div>
      {hidden > 0 ? (
        <p className="text-xs text-muted-foreground">{more}</p>
      ) : null}
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Columns drawn per strip; longer vectors are binned to their extremes. */
const MAX_COLUMNS = 192;
const HEIGHT = 40;

function VectorStrip({ values }: { values: number[] }) {
  const strip = useMemo(() => binned(values), [values]);
  const middle = HEIGHT / 2;
  const scale = strip.maxAbs > 0 ? (middle - 1) / strip.maxAbs : 0;
  return (
    <svg
      role="img"
      aria-label={`${values.length.toLocaleString("en-US")} values from ${strip.min.toFixed(3)} to ${strip.max.toFixed(3)}`}
      viewBox={`0 0 ${strip.columns.length} ${HEIGHT}`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      className="block h-10 w-full"
    >
      <rect
        x={0}
        y={middle - 0.5}
        width={strip.columns.length}
        height={1}
        className="fill-border"
      />
      {strip.columns.map(([low, high], column) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one column per bin
        <g key={column} className="fill-chart-1">
          {high > 0 ? (
            <rect
              x={column}
              y={middle - high * scale}
              width={0.7}
              height={high * scale}
            />
          ) : null}
          {low < 0 ? (
            <rect x={column} y={middle} width={0.7} height={-low * scale} />
          ) : null}
        </g>
      ))}
    </svg>
  );
}

/** Each bin's lowest and highest value, so a spike is never averaged away. */
function binned(values: number[]) {
  const count = Math.min(values.length, MAX_COLUMNS);
  const columns: Array<[number, number]> = [];
  let min = 0;
  let max = 0;
  for (let column = 0; column < count; column++) {
    const start = Math.floor((column * values.length) / count);
    const end = Math.floor(((column + 1) * values.length) / count);
    let low = 0;
    let high = 0;
    for (let index = start; index < end; index++) {
      const value = values[index];
      if (value < low) low = value;
      if (value > high) high = value;
    }
    columns.push([low, high]);
    if (low < min) min = low;
    if (high > max) max = high;
  }
  return { columns, min, max, maxAbs: Math.max(-min, max) };
}
