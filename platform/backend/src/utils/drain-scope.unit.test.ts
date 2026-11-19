import { expect, test } from "vitest";
import {
  drainScopeHeaders,
  takeDrainScope,
  withDrainScope,
} from "./drain-scope";

test("a scope expires after success or failure and strips all proof header views", async () => {
  for (const fails of [false, true]) {
    let headers: Record<string, string> = {};
    const work = withDrainScope(async () => {
      headers = drainScopeHeaders();
      const request = {
        headers: { ...headers },
        raw: {
          headers: { ...headers },
          rawHeaders: Object.entries(headers).flat(),
        },
      };
      expect(takeDrainScope(request)).toBeTruthy();
      expect(request).toEqual({
        headers: {},
        raw: { headers: {}, rawHeaders: [] },
      });
      await Promise.resolve();
      expect(drainScopeHeaders()).toEqual(headers);
      if (fails) throw new Error("synthetic failure");
    });
    if (fails) await expect(work).rejects.toThrow("synthetic failure");
    else await work;
    expect(takeDrainScope({ headers })).toBeUndefined();
    expect(drainScopeHeaders()).toEqual({});
  }
});

test("concurrent turns have separate scopes and nested work retains its parent's scope", async () => {
  await withDrainScope(async () => {
    const headers = drainScopeHeaders();
    await withDrainScope(async () => {
      expect(drainScopeHeaders()).toEqual(headers);
    });
    expect(drainScopeHeaders()).toEqual(headers);
  });
  const headers = await Promise.all(
    [1, 2].map(() => withDrainScope(async () => drainScopeHeaders())),
  );
  expect(headers[0]).not.toEqual(headers[1]);
});

test("preserves a synchronous handler's undefined return and revokes its proof", () => {
  let headers: Record<string, string> = {};
  expect(
    withDrainScope(() => {
      headers = drainScopeHeaders();
    }),
  ).toBeUndefined();
  expect(takeDrainScope({ headers })).toBeUndefined();
});

test("acknowledging a parent does not revoke work its handler already started", async () => {
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let child: Promise<void> | undefined;
  let headers: Record<string, string> = {};
  await withDrainScope(async () => {
    headers = drainScopeHeaders();
    child = withDrainScope(async () => {
      await pending;
      expect(drainScopeHeaders()).toEqual(headers);
    });
  });
  expect(takeDrainScope({ headers: { ...headers } })).toBeTruthy();
  finish();
  await child;
  expect(takeDrainScope({ headers })).toBeUndefined();
});
