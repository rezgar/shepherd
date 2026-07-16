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
 *  A font-size change re-runs `fit()` to recompute cols/rows for the SAME
 *  (unchanged) container size, and DOES send that new size to the server —
 *  this looked wrong at first ("shouldn't font size be purely local?"), but
 *  every real terminal emulator works exactly this way: the window/pane
 *  stays a fixed pixel size and the character grid is recomputed on zoom,
 *  because that's the only way the rendered content can keep exactly
 *  filling that fixed-size container. An earlier version of this tried to
 *  hold cols/rows constant across a font change instead, and that's what
 *  actually broke: same row count at a smaller font needs fewer pixels than
 *  before, so the fixed-size container was left with a real gap of empty
 *  space below the content (confirmed the hard way, reproduced by shrinking
 *  the font a few times). Letting `fit()` run avoids that by construction —
 *  the rendered grid always exactly matches the container, at any font size.
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
  const fitRef = useRef<FitAddon | null>(null);
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
    fitRef.current = fit;

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
      fitRef.current = null;
    };
  }, [resetKey]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = fontSize;
    fit.fit();
    onResizeRef.current(term.cols, term.rows);
  }, [fontSize]);

  return <div className="terminal-view" ref={containerRef} />;
}
