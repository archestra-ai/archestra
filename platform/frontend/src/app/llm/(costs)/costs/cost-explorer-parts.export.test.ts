// @vitest-environment node
import { parquetWriteBuffer } from "hyparquet-writer";
import { describe, expect, it } from "vitest";
import type { Cube } from "./cost-explorer-data";
import { parquetColumns } from "./cost-explorer-parts";

const cube: Cube = {
  buckets: ["2026-11-01", "2026-11-02"],
  rows: [
    {
      key: "a",
      label: "Model A",
      total: 1.125,
      series: [0.375, 0.75],
      hasSeries: true,
      extras: { tokens: 14 },
      children: [],
    },
    {
      key: "b",
      label: "Model B",
      total: 2.25,
      series: [1, 1.25],
      hasSeries: true,
      extras: { tokens: 7 },
      children: [],
    },
  ],
  splitKeys: [],
  extraCols: [{ id: "tokens", label: "tokens", format: String }],
  api: "",
  isLoading: false,
  retry: () => {},
  total: 3.375,
};

describe("cost explorer export columns", () => {
  it("preserves numeric precision and shares in summary exports", () => {
    expect(
      parquetColumns({
        cube,
        metric: "billed",
        dimLabel: "model",
        view: "summary",
        bySplit: false,
      }),
    ).toEqual([
      { name: "model", data: ["Model A", "Model B"], type: "STRING" },
      { name: "tokens", data: [14, 7], type: "DOUBLE" },
      { name: "billed", data: [1.125, 2.25], type: "DOUBLE" },
      { name: "share", data: [1 / 3, 2 / 3], type: "DOUBLE" },
    ]);
  });

  it("exports every metric from the complete summary table with typed values", () => {
    expect(
      parquetColumns({
        cube: {
          ...cube,
          exportTable: {
            header: ["Team", "Credential ID", "Requests", "Billed spend (USD)"],
            rows: [
              ["Operations", "0007", 14, 0.0000125],
              ["Research", "0084", 7, 1.125],
            ],
          },
        },
        metric: "billed",
        dimLabel: "Team",
        view: "summary",
        bySplit: false,
      }),
    ).toEqual([
      { name: "Team", data: ["Operations", "Research"], type: "STRING" },
      { name: "Credential ID", data: ["0007", "0084"], type: "STRING" },
      { name: "Requests", data: [14, 7], type: "DOUBLE" },
      { name: "Billed spend (USD)", data: [0.0000125, 1.125], type: "DOUBLE" },
    ]);
  });

  it("keeps pivot buckets and gives duplicate column names distinct names", () => {
    const columns = parquetColumns({
      cube: {
        ...cube,
        splitKeys: [
          { key: "a", label: "total", total: 1.375 },
          { key: "b", label: "total", total: 2 },
        ],
        rows: cube.rows.map((row) => ({
          ...row,
          children: [
            { key: "a", label: "total", total: row.series[0], series: [] },
            { key: "b", label: "total", total: row.series[1], series: [] },
          ],
        })),
      },
      metric: "billed",
      dimLabel: "model",
      view: "pivot",
      bySplit: true,
    });
    expect(columns.map((column) => column.name)).toEqual([
      "model",
      "total",
      "total (2)",
      "total (3)",
    ]);
    expect(columns[1].data).toEqual([0.375, 1]);
    expect(columns[2].data).toEqual([0.75, 1.25]);
  });

  it("writes a Parquet file from the typed columns", () => {
    const columns = parquetColumns({
      cube,
      metric: "billed",
      dimLabel: "model",
      view: "summary",
      bySplit: false,
    });
    const bytes = new Uint8Array(parquetWriteBuffer({ columnData: columns }));
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("PAR1");
    expect(new TextDecoder().decode(bytes.slice(-4))).toBe("PAR1");
  });
});
