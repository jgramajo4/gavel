import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A command or prompt with a Copy button. The text is always visible and
 * selectable, so a browser that refuses clipboard access still works: Copy
 * then selects the text and says so.
 */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const preRef = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      const node = preRef.current;
      const selection = window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setState('manual');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2500);
  }, [text]);

  return (
    <div className="copy-block">
      <pre ref={preRef} aria-label={label} tabIndex={0}>
        {text}
      </pre>
      <div className="copy-block-actions">
        <button type="button" onClick={copy} aria-label={`Copy ${label}`}>
          Copy
        </button>
        <span role="status" aria-live="polite" className="copy-block-status">
          {state === 'copied' ? 'Copied.' : state === 'manual' ? 'Selected. Press Ctrl+C or ⌘C to copy.' : ''}
        </span>
      </div>
    </div>
  );
}
