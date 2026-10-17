import { type ComponentType, lazy, Suspense } from "react";

/**
 * `React.lazy` that renders synchronously once the module has loaded.
 *
 * Plain `lazy` suspends on its first render even when the chunk is already
 * in memory (its promise settles on a microtask), which flashes the fallback.
 * Here `preload()` fetches the module ahead of need, and a render after it
 * has settled gets the component in the same pass.
 */
export function preloadableLazy<Props>(
  load: () => Promise<{ default: ComponentType<Props> }>,
): {
  Component: ComponentType<Props>;
  preload: () => Promise<void>;
} {
  let loaded: { default: ComponentType<Props> } | null = null;
  let loading: Promise<void> | null = null;
  const preload = () => {
    loading ??= load().then((module) => {
      loaded = module;
    });
    return loading;
  };
  const Component = lazy(() => {
    const module = loaded;
    if (module) {
      // A thenable that resolves synchronously: React marks the lazy
      // component resolved before the render continues.
      const thenable = {
        // biome-ignore lint/suspicious/noThenProperty: a synchronous thenable is the point — React.lazy resolves it in the same render
        then: (resolve: (value: typeof module) => void) => resolve(module),
      };
      return thenable as unknown as Promise<typeof module>;
    }
    return preload().then(() => loaded as { default: ComponentType<Props> });
  }) as unknown as ComponentType<Props>;
  return { Component, preload };
}

/**
 * A lazily loaded component that suspends into an empty boundary of its own,
 * plus its `preload`. For parts of a screen nothing waits for (dialogs,
 * panels, the transcript behind the composer): they drop in when their chunk
 * arrives, without holding the rest of the screen.
 */
export function lazyComponent<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
): ComponentType<Props> & { preload: () => Promise<void> } {
  const view = preloadableLazy<Props>(() =>
    load().then((Component) => ({ default: Component })),
  );
  function LazyComponent(props: Props) {
    return (
      <Suspense fallback={null}>
        <view.Component {...props} />
      </Suspense>
    );
  }
  return Object.assign(LazyComponent, { preload: view.preload });
}
