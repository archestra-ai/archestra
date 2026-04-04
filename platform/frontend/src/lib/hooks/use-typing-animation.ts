import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AnimationPhase = "TYPING" | "PAUSED" | "DELETING" | "PICKING_NEXT";

/**
 * Animates through a list of texts with a typewriter effect.
 * Cycles: type text → pause → delete → pick next.
 */
export function useTypingAnimation(texts: string[] | null | undefined): {
  text: string;
  isAnimating: boolean;
} {
  const [displayText, setDisplayText] = useState("");
  const [isAnimating, setIsAnimating] = useState(false);
  const phaseRef = useRef<AnimationPhase>("PICKING_NEXT");
  const currentIndexRef = useRef(-1);
  const currentTextRef = useRef("");
  const charIndexRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validTextsKey = useMemo(
    () => JSON.stringify(texts?.filter((text) => text.length > 0) ?? []),
    [texts],
  );
  const validTexts = useMemo(
    () => JSON.parse(validTextsKey) as string[],
    [validTextsKey],
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pickNext = useCallback((validTexts: string[]) => {
    if (validTexts.length === 0) return;

    let nextIndex: number;
    if (validTexts.length === 1) {
      nextIndex = 0;
    } else {
      do {
        nextIndex = Math.floor(Math.random() * validTexts.length);
      } while (nextIndex === currentIndexRef.current);
    }

    currentIndexRef.current = nextIndex;
    currentTextRef.current = validTexts[nextIndex];
    charIndexRef.current = 0;
    phaseRef.current = "TYPING";
    setIsAnimating(true);
  }, []);

  useEffect(() => {
    if (validTexts.length === 0) {
      clearTimer();
      setDisplayText("");
      setIsAnimating(false);
      return;
    }

    if (validTexts.length === 1) {
      clearTimer();
      setDisplayText(validTexts[0]);
      setIsAnimating(false);
      return;
    }

    // Reset and start
    phaseRef.current = "PICKING_NEXT";
    currentIndexRef.current = -1;
    setDisplayText("");
    pickNext(validTexts);

    const tick = () => {
      const phase = phaseRef.current;
      const fullText = currentTextRef.current;

      if (phase === "TYPING") {
        charIndexRef.current++;
        const newText = fullText.slice(0, charIndexRef.current);
        setDisplayText(newText);

        if (charIndexRef.current >= fullText.length) {
          phaseRef.current = "PAUSED";
          timerRef.current = setTimeout(tick, 5000);
        } else {
          timerRef.current = setTimeout(tick, 50);
        }
      } else if (phase === "PAUSED") {
        phaseRef.current = "DELETING";
        timerRef.current = setTimeout(tick, 30);
      } else if (phase === "DELETING") {
        charIndexRef.current--;
        const newText = fullText.slice(0, charIndexRef.current);
        setDisplayText(newText);

        if (charIndexRef.current <= 0) {
          phaseRef.current = "PICKING_NEXT";
          pickNext(validTexts);
          timerRef.current = setTimeout(tick, 50);
        } else {
          timerRef.current = setTimeout(tick, 30);
        }
      } else if (phase === "PICKING_NEXT") {
        // pickNext already called, start typing
        timerRef.current = setTimeout(tick, 50);
      }
    };

    timerRef.current = setTimeout(tick, 50);

    return () => {
      clearTimer();
    };
  }, [validTexts, clearTimer, pickNext]);

  return { text: displayText, isAnimating };
}
