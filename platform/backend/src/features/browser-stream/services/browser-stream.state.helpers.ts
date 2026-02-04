import type { Option, Result } from "./browser-stream.state.types";

export const isSome = <T>(
  value: Option<T>,
): value is { tag: "Some"; value: T } => value.tag === "Some";

export const isOk = <E, T>(
  result: Result<E, T>,
): result is { tag: "Ok"; value: T } => result.tag === "Ok";

export const isErr = <E, T>(
  result: Result<E, T>,
): result is { tag: "Err"; error: E } => result.tag === "Err";
