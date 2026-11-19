import { describe, expect, it } from "vitest";
import {
  argumentsFromText,
  argumentsToText,
} from "./container-deployment-fields.utils";

describe("argumentsFromText", () => {
  it("takes each line as one argument, with its inner spaces", () => {
    expect(
      argumentsFromText("/path/to/server.js\n--verbose\n$HOME/My Models"),
    ).toEqual(["/path/to/server.js", "--verbose", "$HOME/My Models"]);
  });

  it("drops empty lines and the spaces around an argument", () => {
    expect(argumentsFromText("  --root  \n\n   \n/data\r\n--quiet\n")).toEqual([
      "--root",
      "/data",
      "--quiet",
    ]);
  });

  it("gives no arguments for no text", () => {
    expect(argumentsFromText("")).toEqual([]);
    expect(argumentsFromText(" \n ")).toEqual([]);
    expect(argumentsFromText(null)).toEqual([]);
    expect(argumentsFromText(undefined)).toEqual([]);
  });
});

describe("argumentsToText", () => {
  it("puts each argument on its own line", () => {
    expect(argumentsToText(["--root", "$HOME/My Models"])).toBe(
      "--root\n$HOME/My Models",
    );
  });

  it("gives no text for no arguments", () => {
    expect(argumentsToText([])).toBe("");
    expect(argumentsToText(null)).toBe("");
    expect(argumentsToText(undefined)).toBe("");
  });

  it("gives back the arguments it is read from", () => {
    const values = ["--name", "two words", "--flag=a b"];
    expect(argumentsFromText(argumentsToText(values))).toEqual(values);
  });
});
