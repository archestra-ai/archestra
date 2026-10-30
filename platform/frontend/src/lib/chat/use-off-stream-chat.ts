"use client";

import { Chat, type UIMessage, useChat } from "@ai-sdk/react";
import type { ChatInit } from "ai";
import { useRef, useState } from "react";

/**
 * `useChat` for one chat whose message updates reach React in their own task,
 * never synchronously inside the SDK's stream processing.
 *
 * The SDK notifies its message subscriber from inside the stream `write()`,
 * which runs in `makeRequest`'s try/catch. When chunks are already buffered the
 * SDK drains them in microtasks, so React's Scheduler never gets a turn to
 * commit pending effect updates and its nested-update counter keeps climbing
 * until React throws "Maximum update depth exceeded" — which the SDK's catch
 * then reports as a chat error and ends the stream. Delivering each update in
 * a macrotask keeps React throws out of the stream and gives the Scheduler a
 * task boundary between renders.
 *
 * Takes `ChatInit` plus `experimental_throttle`; `resume` is not supported.
 * The Chat is created once per hook instance and keeps its first `id`, so
 * callers key the hook's component by chat id.
 */
export function useOffStreamChat<UI_MESSAGE extends UIMessage = UIMessage>({
  experimental_throttle: throttleWaitMs,
  ...init
}: ChatInit<UI_MESSAGE> & { experimental_throttle?: number }) {
  // The Chat keeps the callbacks it was built with; forward through a ref so
  // they always see the caller's latest render (as `useChat` does itself).
  const callbacksRef = useRef(init);
  callbacksRef.current = init;

  const [chat] = useState(() => {
    const created = new Chat<UI_MESSAGE>({
      ...init,
      onToolCall: (arg) => callbacksRef.current.onToolCall?.(arg),
      onData: (arg) => callbacksRef.current.onData?.(arg),
      onFinish: (arg) => callbacksRef.current.onFinish?.(arg),
      onError: (arg) => callbacksRef.current.onError?.(arg),
      sendAutomaticallyWhen: (arg) =>
        callbacksRef.current.sendAutomaticallyWhen?.(arg) ?? false,
    });
    deliverMessageUpdatesInOwnTask(created);
    return created;
  });

  return useChat<UI_MESSAGE>({ chat, experimental_throttle: throttleWaitMs });
}

// ===========================================================================
// Internal
// ===========================================================================

/**
 * `useChat` subscribes to messages through `~registerMessagesCallback`. Wrap it
 * on the instance (a subclass breaks suites that partially mock the SDK) so the
 * subscriber runs from a timer: updates coalesce while one is pending, and the
 * throttle window still spaces deliveries, but the first update after a quiet
 * period goes out on the next task. A React error thrown while delivering now
 * surfaces from the timer instead of ending the stream as a chat error; the
 * next update delivers the latest messages.
 */
function deliverMessageUpdatesInOwnTask<UI_MESSAGE extends UIMessage>(
  chat: Chat<UI_MESSAGE>,
) {
  const register = chat["~registerMessagesCallback"];
  chat["~registerMessagesCallback"] = (onChange, throttleWaitMs = 0) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastDelivery = Number.NEGATIVE_INFINITY;
    const unsubscribe = register(() => {
      if (timer !== undefined) {
        return;
      }
      const delay = Math.max(0, throttleWaitMs - (Date.now() - lastDelivery));
      timer = setTimeout(() => {
        timer = undefined;
        lastDelivery = Date.now();
        onChange();
      }, delay);
    });
    return () => {
      clearTimeout(timer);
      timer = undefined;
      unsubscribe();
    };
  };
}
