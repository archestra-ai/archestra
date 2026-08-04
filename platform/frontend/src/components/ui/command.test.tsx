import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  // cmdk reveals its selected item this way; jsdom has no layout, so the call
  // only needs to exist.
  Element.prototype.scrollIntoView = () => {};
});

const MODELS = [
  "Claude Opus 5",
  "Claude Opus 4.5",
  "GPT-5.6 Sol Pro",
  "Kimi K2 0905",
  "Step 3.5 Flash",
];

function renderPicker(options: string[] = MODELS) {
  const view = render(
    <Command>
      <CommandInput placeholder="Search models..." />
      <CommandList>
        <CommandEmpty>No models found.</CommandEmpty>
        {options.map((name) => (
          <CommandItem key={name} value={name}>
            {name}
          </CommandItem>
        ))}
      </CommandList>
    </Command>,
  );
  const list = view.container.querySelector("[cmdk-list]") as HTMLElement;
  const input = view.container.querySelector("[cmdk-input]") as HTMLElement;
  return { ...view, list, input };
}

describe("CommandList", () => {
  // The results a query produces are ranked best-first, so a container left at
  // its previous offset hides exactly the rows the user searched for.
  it("returns to the top of the list when the query changes", async () => {
    const { list, input } = renderPicker();
    list.scrollTop = 480;

    fireEvent.change(input, { target: { value: "opus" } });

    await waitFor(() => expect(list.scrollTop).toBe(0));
  });

  it("returns to the top again when the query is cleared", async () => {
    const { list, input } = renderPicker();
    fireEvent.change(input, { target: { value: "opus" } });
    await waitFor(() => expect(list.scrollTop).toBe(0));

    list.scrollTop = 260;
    fireEvent.change(input, { target: { value: "" } });

    await waitFor(() => expect(list.scrollTop).toBe(0));
  });

  // Only a new query means a new list. Rerenders that leave the query alone —
  // options arriving from a fetch, say — must not yank the user's scroll
  // position back, and neither must the first render, which is when cmdk
  // reveals an already-selected item.
  it("leaves the scroll position alone when the query is unchanged", async () => {
    const { list, input, rerender } = renderPicker();
    fireEvent.change(input, { target: { value: "claude" } });
    await waitFor(() => expect(list.scrollTop).toBe(0));

    list.scrollTop = 320;
    rerender(
      <Command>
        <CommandInput placeholder="Search models..." />
        <CommandList>
          <CommandEmpty>No models found.</CommandEmpty>
          {[...MODELS, "Claude Fable Latest"].map((name) => (
            <CommandItem key={name} value={name}>
              {name}
            </CommandItem>
          ))}
        </CommandList>
      </Command>,
    );

    await waitFor(() =>
      expect(
        document.querySelectorAll("[cmdk-item]:not([hidden])").length,
      ).toBeGreaterThan(0),
    );
    expect(list.scrollTop).toBe(320);
  });
});
