import { describe, expect, it } from "vitest";
import {
  clearEnvironmentDialogParams,
  setEnvironmentCreateParam,
  setEnvironmentDefaultsParam,
  setEnvironmentEditParam,
} from "./environment-edit-link";

describe("setEnvironmentEditParam", () => {
  it("adds the edit param to an empty search", () => {
    expect(setEnvironmentEditParam("", "env-1")).toBe("edit=env-1");
  });

  it("preserves existing params", () => {
    const result = new URLSearchParams(
      setEnvironmentEditParam("foo=bar", "env-1"),
    );
    expect(result.get("foo")).toBe("bar");
    expect(result.get("edit")).toBe("env-1");
  });

  it("overwrites an existing edit param", () => {
    expect(setEnvironmentEditParam("edit=old", "new")).toBe("edit=new");
  });

  it("drops the create param (dialogs are mutually exclusive)", () => {
    const result = new URLSearchParams(
      setEnvironmentEditParam("create=1", "x"),
    );
    expect(result.has("create")).toBe(false);
    expect(result.get("edit")).toBe("x");
  });

  it("accepts the default sentinel as an id", () => {
    expect(setEnvironmentEditParam("", "default")).toBe("edit=default");
  });

  it("drops the resource-defaults param", () => {
    const result = new URLSearchParams(
      setEnvironmentEditParam("resource-defaults=1", "env-1"),
    );
    expect(result.has("resource-defaults")).toBe(false);
    expect(result.get("edit")).toBe("env-1");
  });
});

describe("setEnvironmentCreateParam", () => {
  it("adds the create param to an empty search", () => {
    expect(setEnvironmentCreateParam("")).toBe("create=1");
  });

  it("drops the edit param (dialogs are mutually exclusive)", () => {
    const result = new URLSearchParams(setEnvironmentCreateParam("edit=env-1"));
    expect(result.has("edit")).toBe(false);
    expect(result.get("create")).toBe("1");
  });

  it("drops the resource-defaults param", () => {
    const result = new URLSearchParams(
      setEnvironmentCreateParam("resource-defaults=1"),
    );
    expect(result.has("resource-defaults")).toBe(false);
    expect(result.get("create")).toBe("1");
  });
});

describe("setEnvironmentDefaultsParam", () => {
  it("adds the resource-defaults param to an empty search", () => {
    expect(setEnvironmentDefaultsParam("")).toBe("resource-defaults=1");
  });

  it("drops the editor params (dialogs are mutually exclusive)", () => {
    const result = new URLSearchParams(
      setEnvironmentDefaultsParam("edit=env-1&create=1"),
    );
    expect(result.has("edit")).toBe(false);
    expect(result.has("create")).toBe(false);
    expect(result.get("resource-defaults")).toBe("1");
  });

  it("preserves other params", () => {
    const result = new URLSearchParams(setEnvironmentDefaultsParam("foo=bar"));
    expect(result.get("foo")).toBe("bar");
    expect(result.get("resource-defaults")).toBe("1");
  });
});

describe("clearEnvironmentDialogParams", () => {
  it("removes every dialog param", () => {
    expect(clearEnvironmentDialogParams("edit=env-1")).toBe("");
    expect(clearEnvironmentDialogParams("create=1")).toBe("");
    expect(clearEnvironmentDialogParams("resource-defaults=1")).toBe("");
  });

  it("preserves other params", () => {
    const result = new URLSearchParams(
      clearEnvironmentDialogParams("foo=bar&edit=env-1"),
    );
    expect(result.get("foo")).toBe("bar");
    expect(result.has("edit")).toBe(false);
  });

  it("is a no-op when there are no dialog params", () => {
    expect(clearEnvironmentDialogParams("foo=bar")).toBe("foo=bar");
  });
});
