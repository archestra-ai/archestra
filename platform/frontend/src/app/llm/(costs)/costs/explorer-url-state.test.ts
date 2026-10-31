// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  decodeCostExplorer,
  decodeExplorerTable,
  decodePersonalExplorer,
  encodeCostExplorer,
  encodeExplorerTable,
  encodePersonalExplorer,
} from "./explorer-url-state";

describe("shareable explorer state", () => {
  it("round trips a model drill-down, table view, and exact selected identities", () => {
    const query = new URLSearchParams({
      model: "vendor/model+a,b",
      metric: "tokens",
      group: "key",
      chart: "lines",
      mobileChart: "bars",
      view: "pivot",
      columns: "split",
    });
    query.append("focus", "key/one,a");
    query.append("focus", "key+two");
    const state = decodeCostExplorer(query);
    expect(state.query).toMatchObject({
      model: "vendor/model+a,b",
      metric: "tokens",
      group: "key",
      chart: "lines",
      split: "none",
    });
    expect(state.view).toBe("pivot");
    expect(state.mobileChart).toBe("bars");
    expect(decodeCostExplorer(encodeCostExplorer(state))).toEqual(state);
  });
  it("rejects unsupported combinations and unknown control values", () => {
    const state = decodeCostExplorer(
      new URLSearchParams(
        "metric=bogus&group=bogus&chart=bogus&split=bogus&view=bogus",
      ),
    );
    expect(state.query).toMatchObject({
      metric: "billed",
      group: "model",
      chart: "bars",
      split: "none",
    });
    expect(state.view).toBe("summary");
    const filtered = decodeCostExplorer(
      new URLSearchParams(
        "model=example&metric=toolCalls&group=server&split=person",
      ),
    );
    expect(filtered.query).toMatchObject({
      metric: "billed",
      group: "person",
      split: "none",
    });
  });
  it("restores personal client and token-type views without exposing organization scopes", () => {
    const filtered = decodePersonalExplorer(
      new URLSearchParams("model=example&group=person&metric=requests"),
    );
    expect(filtered.group).toBe("client");
    expect(decodePersonalExplorer(encodePersonalExplorer(filtered))).toEqual(
      filtered,
    );
    const tokens = decodePersonalExplorer(
      new URLSearchParams("metric=tokens&group=model&split=token&view=pivot"),
    );
    expect(tokens.split).toBe(true);
    expect(tokens.view).toBe("pivot");
    expect(
      decodePersonalExplorer(
        new URLSearchParams("metric=cacheSavings&group=overall&chart=bars"),
      ).chart,
    ).toBe("bars");
  });
});

it("round trips a sorted expanded table, including ids containing commas", () => {
  const params = new URLSearchParams({
    sort: "x:requests",
    direction: "asc",
    rows: "all",
  });
  params.append("expanded", "model/one,a");
  const table = decodeExplorerTable(params);
  expect(table.sort).toEqual({ key: "x:requests", dir: 1 });
  expect(table.showAll).toBe(true);
  expect(decodeExplorerTable(encodeExplorerTable(table))).toEqual(table);
});
