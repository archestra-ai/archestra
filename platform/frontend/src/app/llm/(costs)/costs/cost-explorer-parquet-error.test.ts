import { toast } from "sonner";
import { expect, it, vi } from "vitest";
import type { Cube } from "./cost-explorer-data";
import { exportParquet } from "./cost-explorer-parts";

vi.mock("hyparquet-writer", () => ({
  parquetWriteBuffer: () => {
    throw new Error("write failed");
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

it("reports a Parquet serialization failure", async () => {
  const cube: Cube = {
    buckets: [],
    rows: [],
    splitKeys: [],
    extraCols: [],
    api: "",
    isLoading: false,
    retry: () => {},
    total: 0,
  };
  await exportParquet({
    cube,
    metric: "billed",
    dimLabel: "Model",
    view: "summary",
    bySplit: false,
    filename: "costs.csv",
  });
  expect(toast.error).toHaveBeenCalledWith("Could not export Parquet file");
});
