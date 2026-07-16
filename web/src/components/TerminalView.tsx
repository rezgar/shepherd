import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** Renders a session's live raw PTY output. `resetKey` changing forces a
 *  fresh Terminal instance (used when switching sessions, since xterm.js
 *  doesn't support re-pointing one instance at a different backing stream
 *  cleanly). Font size mirrors the app's existing A-/A+ control directly via
 *  xterm's own `fontSize` option, not the old `--chat-font` CSS variable
 *  (which only ever styled the chat reconstruction this replaces).
 *
 *  `subscribeTerminal` is called directly in the mount effect and every
 *  chunk is written straight to the Terminal instance — deliberately NOT
 *  passed in as a `chunk` prop updated via `useState`. A burst of output
 *  arriving faster than a render cycle (normal for a live terminal — a
 *  spinner alone redraws many times a second) has React batch/coalesce
 *  state updates, silently dropping every chunk in a batch except the last
 *  (confirmed the hard way: the terminal froze on a stale mid-spinner frame
 *  while the real session had already gone idle). Subscribing directly
 *  means every chunk is applied, in order, with nothing in between to drop it.
 *
 *  `onResize` is captured in a ref (kept fresh every render) rather than
 *  listed as an effect dependency — it's a fresh function identity on every
 *  parent render, and listing it would force the terminal to tear down and
 *  rebuild on every render instead of only on a genuine session switch. */
export function TerminalView({
  resetKey,
  subscribeTerminal,
  fontSize,
  onResize,
}: {
  resetKey: string;
  subscribeTerminal: (onChunk: (chunk: string) => void) => () => void;
  fontSize: number;
  onResize: (cols: number, rows: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const subscribeRef = useRef(subscribeTerminal);
  subscribeRef.current = subscribeTerminal;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontSize: fontSizeRef.current,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
      },
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    onResizeRef.current(term.cols, term.rows);
    termRef.current = term;

    const unsubscribe = subscribeRef.current((chunk) => term.write(chunk));

    const ro = new ResizeObserver(() => {
      fit.fit();
      onResizeRef.current(term.cols, term.rows);
    });
    ro.observe(container);

    return () => {
      unsubscribe();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [resetKey]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // xterm.js reflows cols/rows to keep filling the same pixel-sized canvas
    // when font metrics change — confirmed the hard way: A+/A- silently sent
    // a pty.resize as a side effect, resizing the REMOTE session's terminal
    // just from a local font-size change. Capture the grid before, and force
    // it back after, so the only thing that changes is how big the text
    // renders — this never goes through onResize, so no resize message is
    // ever sent to the server for a pure font-size adjustment.
    const { cols, rows } = term;
    term.options.fontSize = fontSize;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  }, [fontSize]);

  return <div className="terminal-view" ref={containerRef} />;
}
