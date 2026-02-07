// Option/Result type utilities
export type Option<T> = { tag: "Some"; value: T } | { tag: "None" };

export const Some = <T>(value: T): Option<T> => ({ tag: "Some", value });
export const None: Option<never> = { tag: "None" };

export type Result<E, T> = { tag: "Ok"; value: T } | { tag: "Err"; error: E };

export const Ok = <E, T>(value: T): Result<E, T> => ({ tag: "Ok", value });
export const Err = <E, T>(error: E): Result<E, T> => ({ tag: "Err", error });

/**
 * Simplified browser state - one tab per conversation.
 * Stores just the URL and tab index (which may become stale).
 */
export type SimpleBrowserState = {
  url: string;
  tabIndex?: number;
};
