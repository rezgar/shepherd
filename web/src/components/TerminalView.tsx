import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createInlineArtifactLayer } from '../lib/inlineArtifacts';

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
 *  The terminal is INTERACTIVE: it holds keyboard focus so you can just
 *  type, and every keystroke / paste / control sequence xterm produces is
 *  forwarded straight to the pty via `onData` — this is Claude Code's own
 *  native input (arrow-key history, slash-command menus, Esc-to-interrupt),
 *  replacing the old output-only view + HTML composer. xterm's hidden
 *  `<textarea>` captures keys before app-level shortcuts, so the one
 *  shortcut kept alive here is the session-number jump: `Alt+<digit>` is
 *  passed through (the custom key handler returns false) so it reaches the
 *  window listener instead of being typed. Ctrl/Cmd+C with an active
 *  selection is likewise passed through so the browser copies rather than
 *  xterm sending SIGINT — that check must use xterm's OWN `hasSelection()`,
 *  since xterm manages selection as its own internal model that the
 *  browser's `window.getSelection()` never sees.
 *
 *  Attach carries this terminal's own fit size (`onAttach`, once, after the
 *  initial `fit()`), and the server serializes its screen mirror at exactly
 *  that size. So the reconstruction the client receives is already the right
 *  width and reflows nothing on arrival. This replaces an earlier design that
 *  replayed raw PTY bytes captured at whatever width the PTY happened to be at:
 *  fed into an xterm reflowing them at a different width, they rendered
 *  corrupted — words fused, lines misaligned (#31/#45) — and the only reliable
 *  fix was a racy ±1-column resize "nudge" to force a full CLI repaint. With a
 *  width-matched snapshot there is nothing to reflow, so the nudge is gone.
 *  `onFirstChunk` now only pins the viewport to the bottom when the snapshot
 *  lands, so the CLI's bottom-anchored input box is visible rather than
 *  scrolled off below the fold. */
export function TerminalView({
  resetKey,
  subscribeTerminal,
  fontSize,
  onAttach,
  onResize,
  onInput,
  active,
  resolveImageSrc,
}: {
  resetKey: string;
  subscribeTerminal: (onChunk: (chunk: string) => void) => () => void;
  fontSize: number;
  /** Called once on mount, after the initial fit, with the terminal's own grid
   *  size. The parent attaches the session at exactly this size so the server's
   *  snapshot is width-matched and can't reflow/garble on arrival. */
  onAttach: (cols: number, rows: number) => void;
  onResize: (cols: number, rows: number) => void;
  /** Raw terminal input from xterm (keystrokes, paste, control sequences),
   *  forwarded straight to the session's pty — the native-input path. */
  onInput: (data: string) => void;
  /** When false (e.g. a modal is open over the view) the terminal blurs, so
   *  keystrokes don't leak into the pty behind it. */
  active: boolean;
  /** Maps an image path (from a Write/Read tool block) to a loadable URL, so the
   *  inline-artifact layer can render images inline. */
  resolveImageSrc?: (path: string) => string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onAttachRef = useRef(onAttach);
  onAttachRef.current = onAttach;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const subscribeRef = useRef(subscribeTerminal);
  subscribeRef.current = subscribeTerminal;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const activeRef = useRef(active);
  activeRef.current = active;
  const resolveImageSrcRef = useRef(resolveImageSrc);
  resolveImageSrcRef.current = resolveImageSrc;

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
      // registerDecoration (used by the inline-artifact layer) is EXPERIMENTAL.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Inline diagram/image rendering: once a burst of output settles, scan the
    // buffer for mermaid blocks / image placeholders and cover each at its exact
    // size. Debounced so a redrawing TUI (spinners, streaming) doesn't rescan on
    // every frame; the layer dedupes by live marker so a settled block is covered
    // once and survives later turns.
    const artifacts = createInlineArtifactLayer(term, {
      resolveImageSrc: (p) => resolveImageSrcRef.current?.(p) ?? null,
    });
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleScan = () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => artifacts.scan(), 200);
    };

    // Let xterm process keys natively (it forwards them to the pty via onData
    // below), EXCEPT the cases the app owns — returning false hands the event
    // back to the browser / window listeners instead of typing it:
    //  - Ctrl/Cmd+C with a selection → let the browser copy (xterm would
    //    otherwise swallow it as SIGINT). Confirmed the hard way this was the
    //    blocker even after selections were forming correctly.
    //  - Ctrl/Cmd+V → paste the clipboard into the input. xterm would send a
    //    bare Ctrl+V (0x16) otherwise; instead we read the clipboard and feed
    //    it through `term.paste`, which brackets it so the CLI inserts it
    //    literally (newlines preserved, nothing submitted).
    //  - Shift+Enter → insert a newline instead of submitting. A bare CR can't
    //    be told apart from a submit, so we paste a bracketed "\n", which the
    //    CLI inserts as a soft newline in the input.
    //  - Alt+<digit> → the app's session-number jump, so it still switches
    //    sessions instead of being typed into the terminal.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        return false;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {
            /* clipboard blocked (no permission / insecure context) — no-op */
          });
        return false;
      }
      if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        term.paste('\n');
        return false;
      }
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        return false;
      }
      return true;
    });

    // Native input: forward every keystroke / paste / control sequence xterm
    // produces straight to the session's pty, and take focus so you can type
    // immediately.
    term.onData((data) => onInputRef.current(data));
    term.focus();

    // Subscribe FIRST, then attach — so no output the attach triggers can slip
    // in before we're listening. On the first chunk (the server's width-matched
    // snapshot), pin the viewport to the bottom so the CLI's bottom-anchored
    // input box is on-screen, not scrolled off below the fold.
    let onFirstChunk: (() => void) | null = () => {
      onFirstChunk = null;
      term.scrollToBottom();
    };
    const unsubscribe = subscribeRef.current((chunk) => {
      term.write(chunk);
      onFirstChunk?.();
      scheduleScan();
    });

    // Attach at exactly this terminal's fit size. The server sizes the PTY and
    // its screen mirror to match, then serializes the snapshot — so what comes
    // back reflows nothing and can't garble (this replaces the old raw-byte
    // replay + ±1-column repaint nudge that fought #31/#45).
    onAttachRef.current(term.cols, term.rows);

    // Coalesce rapid container-size changes (layout thrash — the usage bar
    // ticking, the strip re-rendering, a window drag) into a single fit once
    // they settle, then tell the server the new size. The PTY + mirror resize
    // and the CLI repaints at the new size; the client is already fit to it, so
    // there's nothing to reflow. Pin to the bottom afterwards so the input line
    // stays visible across the resize.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        fit.fit();
        onResizeRef.current(term.cols, term.rows);
        term.scrollToBottom();
      }, 120);
    });
    ro.observe(container);

    return () => {
      clearTimeout(settleTimer);
      clearTimeout(scanTimer);
      unsubscribe();
      ro.disconnect();
      artifacts.dispose();
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
    term.scrollToBottom();
    // Clicking the A−/A+ buttons moved focus off the terminal; reclaim it so
    // typing keeps reaching the pty without a click back in. Skip if a modal
    // is over the view (don't focus the terminal behind it).
    if (activeRef.current) term.focus();
  }, [fontSize]);

  // Blur when deactivated (a modal opened over the view) so keys don't leak
  // into the pty behind it; refocus when it's the active surface again.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (active) term.focus();
    else term.blur();
  }, [active]);

  return <div className="terminal-view" ref={containerRef} />;
}
