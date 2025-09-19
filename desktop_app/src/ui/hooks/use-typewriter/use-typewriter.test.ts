import { act, renderHook } from '@testing-library/react';

import { useTypewriter } from '.';

describe('useTypewriter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start with empty string', () => {
    const { result } = renderHook(() => useTypewriter('Hello, world!'));
    expect(result.current.displayedText).toBe('');
    expect(result.current.isComplete).toBe(false);
  });

  it('should type out text character by character', () => {
    const { result } = renderHook(() => useTypewriter('Hello', 100));

    expect(result.current.displayedText).toBe('');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.displayedText).toBe('H');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.displayedText).toBe('He');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.displayedText).toBe('Hel');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.displayedText).toBe('Hell');

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.displayedText).toBe('Hello');
    expect(result.current.isComplete).toBe(true);
  });

  it('should reset when text changes', () => {
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text, 100), {
      initialProps: { text: 'First' },
    });

    // Type out first text
    act(() => {
      vi.advanceTimersByTime(500); // Complete first text
    });
    expect(result.current.displayedText).toBe('First');
    expect(result.current.isComplete).toBe(true);

    // Change text
    rerender({ text: 'Second' });
    expect(result.current.displayedText).toBe('');
    expect(result.current.isComplete).toBe(false);

    // Type out new text
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.displayedText).toBe('Se');
  });

  it('should handle empty text', () => {
    const { result } = renderHook(() => useTypewriter(''));
    expect(result.current.displayedText).toBe('');
    expect(result.current.isComplete).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.displayedText).toBe('');
    expect(result.current.isComplete).toBe(false);
  });

  it('should respect custom speed', () => {
    const { result } = renderHook(() => useTypewriter('Hi', 50));

    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(result.current.displayedText).toBe('');

    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(result.current.displayedText).toBe('H');

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.displayedText).toBe('Hi');
  });

  it('should clean up interval on unmount', () => {
    const { unmount } = renderHook(() => useTypewriter('Test', 100));

    act(() => {
      vi.advanceTimersByTime(100);
    });

    unmount();

    // Advancing timers after unmount shouldn't cause errors
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  });

  it('should handle rapid text changes correctly', () => {
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text, 50), {
      initialProps: { text: 'New Agent' },
    });

    // Start typing
    act(() => {
      vi.advanceTimersByTime(100); // 2 characters
    });
    expect(result.current.displayedText).toBe('Ne');

    // Change text mid-animation
    rerender({ text: 'Updated Title' });
    expect(result.current.displayedText).toBe('');

    // Continue with new text
    act(() => {
      vi.advanceTimersByTime(150); // 3 characters
    });
    expect(result.current.displayedText).toBe('Upd');
  });

  it('should handle special characters and unicode', () => {
    const testText = 'Hello 👋 World!';
    const { result } = renderHook(() => useTypewriter(testText, 50));

    // Type out all characters
    act(() => {
      vi.advanceTimersByTime(testText.length * 50); // Advance enough time for all characters
    });

    expect(result.current.displayedText).toBe(testText);
    expect(result.current.isComplete).toBe(true);
  });
});
