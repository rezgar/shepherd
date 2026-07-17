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
 *  rebuild on every render instead of only on a genuine session switch.
 *
 *  Only holds keyboard focus while there's an active text selection —
 *  never otherwise. xterm.js creates a hidden `<textarea>` to capture every
 *  keystroke, and once that textarea has focus it swallows key events
 *  before app-level shortcuts (Alt+N session switching, etc.) ever see
 *  them — confirmed the hard way: clicking into the terminal silently
 *  broke every keyboard shortcut until you clicked back into the composer.
 *  `tabIndex=-1` keeps Tab from landing on it; a `mouseup` listener blurs
 *  it back to nothing UNLESS `term.hasSelection()` is true, releasing focus
 *  after a plain click but keeping it through a text-selection drag.
 *
 *  That selection check has to go through xterm's OWN `hasSelection()` /
 *  `getSelection()` API, not `window.getSelection()` — xterm manages
 *  selection as its own internal model, not real native DOM text
 *  selection, so the browser's selection API never sees it at all.
 *  Confirmed the hard way this mattered: an earlier version blurred on
 *  every `focusin` instead of `mouseup`, which fires at mousedown — before
 *  a drag can even start — and silently broke copy entirely, since
 *  yanking focus away mid-gesture stops xterm's own mousemove-driven
 *  selection tracking from ever registering a selection in the first
 *  place, not just from surviving until Ctrl+C.
 *
 *  A fresh attach's replayed scrollback (see attachTerminal's ring-buffer
 *  replay) can render corrupted — words fused together, lines misaligned —
 *  because it's raw bytes the CLI wrapped for whatever terminal width the
 *  PTY happened to be at when they were originally written, being fed into
 *  an xterm.js instance that's reflowing them at THIS client's own fit()
 *  width instead. The size sent on mount doesn't reliably fix this even
 *  when it's a genuine change, because it races the replay itself — sent
 *  from the same effect, it can reach the server before or after the
 *  replay it needs to invalidate. Confirmed the hard way that only a
 *  resize sent well AFTER content has landed (e.g. manually clicking
 *  A-/A+) reliably forces the CLI to do a full fresh repaint that
 *  overwrites the corruption. `onFirstChunk` below reproduces that by
 *  construction — tied to "the first chunk (replay or live) has actually
 *  been written", not a guessed timeout. */
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

    // xterm.js does NOT copy on Ctrl+C by default — a real terminal needs
    // Ctrl+C to send SIGINT, so its own internal keydown handling always
    // preventDefaults it, which blocks the browser's native
    // copy-the-selection behavior too, selection or not. Returning `false`
    // here tells xterm to skip its own handling for exactly this one case
    // (Ctrl/Cmd+C with an active selection) instead of preventing the
    // default — letting the browser's native copy shortcut run normally.
    // Confirmed the hard way this was the actual blocker: even after
    // fixing the focus-yanking bug that stopped selections from forming at
    // all, Ctrl+C with a real selection still copied nothing without this.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        return false;
      }
      return true;
    });

    const helperTextarea = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (helperTextarea) helperTextarea.tabIndex = -1;
    const releaseFocusIfNoSelection = () => {
      if (term.hasSelection()) return;
      helperTextarea?.blur();
    };
    container.addEventListener('mouseup', releaseFocusIfNoSelection);

    // Force the CLI to do a full fresh repaint at the current grid size by
    // nudging the width one column and back. A same-size resize is a no-op
    // that triggers no repaint, so the one-column change guarantees a real
    // change is observed even if term.cols already matches the PTY's current
    // size. The two sends are spaced apart, not fired back to back — confirmed
    // the hard way that an instant pair can coalesce into a single net-zero
    // resize (only the final size ever reaches the pty), which never triggers a
    // repaint and left a session's terminal completely blank. Guarded against a
    // degenerate cols/rows (container not laid out yet). Used both after the
    // first chunk lands (fixes replayed-scrollback garble, #31) and after a
    // resize settles (fixes mid-session garble when the layout shifts, #45).
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
    const nudgeRepaint = () => {
      const { cols, rows } = term;
      if (cols < 2 || rows < 1) return;
      onResizeRef.current(cols - 1, rows);
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => onResizeRef.current(cols, rows), 150);
    };

    let onFirstChunk: (() => void) | null = () => {
      onFirstChunk = null;
      nudgeRepaint();
    };
    const unsubscribe = subscribeRef.current((chunk) => {
      term.write(chunk);
      onFirstChunk?.();
    });

    // Coalesce rapid container-size changes (layout thrash — the usage bar
    // ticking, the strip re-rendering, a window drag) into a single fit + clean
    // repaint once they settle. Un-debounced (the previous behavior), every
    // intermediate size was pushed straight to the pty, so in-flight output
    // wrapped at a width the display kept disagreeing with until a manual font
    // change forced a repaint (#45). The trailing nudge guarantees the CLI
    // repaints cleanly at the settled size rather than leaving reflowed garble.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        fit.fit();
        nudgeRepaint();
      }, 120);
    });
    ro.observe(container);

    return () => {
      clearTimeout(nudgeTimer);
      clearTimeout(settleTimer);
      container.removeEventListener('mouseup', releaseFocusIfNoSelection);
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
