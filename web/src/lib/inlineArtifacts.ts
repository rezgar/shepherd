import type { Terminal } from '@xterm/xterm';
import mermaid from 'mermaid';

/** Inline rendering of diagrams/images inside the terminal, without touching
 *  the byte stream. We never inject or move lines — the content Claude already
 *  printed IS the space reservation:
 *   - a ```mermaid block is N source rows tall; we cover exactly those rows with
 *     the rendered diagram, so text above/below is untouched (no overlap).
 *   - an image has no natural block, so a Claude Code hook prints an N-row
 *     placeholder where the image goes; we cover that.
 *
 *  Covering = an xterm decoration (registerMarker + registerDecoration) anchored
 *  to the block's first line, holding an opaque, exact-size DOM card. The marker
 *  tracks the line through scroll/reflow and is disposed on a buffer clear — both
 *  behaviours confirmed against a live Claude Code TUI. Requires the terminal to
 *  be created with `allowProposedApi: true` (registerDecoration is EXPERIMENTAL). */

export type ArtifactKind = 'mermaid' | 'image' | 'svg';

export interface ArtifactBlock {
  /** Absolute buffer line index of the block's first row (inclusive). */
  start: number;
  /** Absolute buffer line index of the block's last row (inclusive). */
  end: number;
  kind: ArtifactKind;
  /** The block's text — mermaid source for `mermaid`, raw markup for `svg`. */
  source: string;
  /** Filesystem path of the image, for `kind === 'image'`. */
  path?: string;
}

// A mermaid block opens with one of these diagram-type keywords at line start.
const MERMAID_START =
  /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|gitGraph|requirementDiagram|C4Context)\b/;
// A line that still looks like mermaid source — so we walk PAST the blank lines
// mermaid puts between groups instead of stopping at the first one. Three signals:
//   1. an edge/relation token anywhere (flowchart -->, sequence ->>/-->>, class
//      <|--/*--/o--, state -->, er ||--o{, dotted -.->/..>);
//   2. a structural keyword at LINE START (subgraph/end/actor/participant/alt/
//      else/opt/loop/par/note/… — sequence & block declarations that carry no
//      arrow); anchored so prose merely mentioning the word doesn't match;
//   3. a node definition at LINE START — an identifier immediately followed by a
//      bracket (`Id[…]`, `Id{…}`, `Id(…)`).
// It deliberately does NOT treat mere indentation as content: Claude Code indents
// the prose that follows a code block, and matching that swallowed the trailing
// paragraph into the diagram (a mermaid parse error). Prose — even with parens or
// keywords mid-sentence — doesn't START with a keyword/node-def and carries no
// arrow, so it ends the block. Ground-truth source from the JSONL (D2) would make
// this exact rather than heuristic (needed for class/state member lines); follow-up.
const MERMAID_LINE =
  /-->|-\.->|-->>|->>|->|--x|-x|--\)|-\)|==>|---|:::|<\|--|\*--|o--|\.\.>|\|\||^\s*(subgraph|end|actor|participant|alt|else|opt|loop|par|and|rect|note|activate|deactivate|class|state|namespace|section|title|direction|click|style|classDef|linkStyle)\b|^\s*%%|^\s*[\w"'.]+\s*[[{(]/;

// An image the model writes or reads shows up as a Write/Read tool block naming
// an image file. The block ITSELF is the reserved space — Claude Code prints a
// multi-row file/preview under it — so we cover that block with the rendered
// image. No hook, no placeholder convention: the tool output is the anchor, the
// same way mermaid source is.
//
// IMG_TOOL_OPEN matches only the START of the tool call (anchored to line start,
// optionally after Claude Code's single bullet glyph, so a tool name mentioned
// mid-sentence in prose can't false-match). The path is then reconstructed by
// joining rows until the closing ")" — Claude Code wraps a long absolute path
// across several indented continuation lines, so the extension and ")" often land
// on a later row than the "Write(".
const IMG_TOOL_OPEN = /^\s*(?:\S\s+)?(?:Write|Read|Edit|Update)\(/i;
const IMG_TOOL_PATH = /(?:Write|Read|Edit|Update)\(\s*([^)]*?)\s*\)/i;
const IMG_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/** Locate every diagram/image block in the buffer's plain text. Pure over the
 *  line array so it can be unit-tested without a live terminal. `lines[i]` is the
 *  text of absolute buffer line `i` (trailing whitespace already trimmed). */
export function detectArtifacts(lines: string[]): ArtifactBlock[] {
  const out: ArtifactBlock[] = [];

  // Image tool blocks: a Write/Read(<image file>) call, then its indented preview.
  for (let i = 0; i < lines.length; i++) {
    if (!IMG_TOOL_OPEN.test(lines[i])) continue;
    // Reconstruct the parenthesised path, joining wrapped continuation rows (their
    // indent is stripped) until the closing ")".
    let joined = lines[i];
    let closeRow = i;
    for (let j = i; j < lines.length && j <= i + 4; j++) {
      if (j > i) joined += lines[j].trimStart();
      closeRow = j;
      if (joined.includes(')')) break;
    }
    const m = joined.match(IMG_TOOL_PATH);
    if (!m || !IMG_EXT.test(m[1])) continue; // not a complete image path
    const path = m[1].trim();
    // Extend from the tool line through the last indented output row (the "Wrote N
    // lines" / file preview), ending at the next non-indented bullet/prose.
    let end = closeRow;
    for (let j = closeRow + 1; j < lines.length && j < closeRow + 60; j++) {
      if (lines[j].trim() === '') continue; // blank line within the tool output
      if (/^\s+\S/.test(lines[j])) {
        end = j; // indented preview row
        continue;
      }
      break; // non-indented → next bullet / prose
    }
    out.push({ start: i, end, kind: 'image', source: '', path });
    i = end;
  }

  // Mermaid blocks: a start keyword, then source lines (blank-tolerant) until a
  // closing ``` fence or the first line of prose.
  for (let i = 0; i < lines.length; i++) {
    if (!MERMAID_START.test(lines[i])) continue;
    let start = i;
    let end = i;
    if (start > 0 && /```/.test(lines[start - 1])) start -= 1; // fold in the opening fence
    for (let j = i + 1; j < lines.length && j < i + 200; j++) {
      if (/^\s*```/.test(lines[j])) {
        end = j;
        break;
      }
      if (lines[j].trim() === '') continue; // blank line inside the diagram
      if (MERMAID_LINE.test(lines[j])) {
        end = j;
        continue;
      }
      break; // prose → the block ended at the last source line
    }
    out.push({ start, end, kind: 'mermaid', source: lines.slice(i, end + 1).join('\n') });
    i = end;
  }

  // Inline SVG blocks: the model printed <svg …> … </svg> straight into the text
  // (rather than writing a file). The markup itself is the image — render it directly.
  for (let i = 0; i < lines.length; i++) {
    if (!/<svg[\s>]/i.test(lines[i])) continue;
    let end = -1;
    for (let j = i; j < lines.length && j < i + 400; j++) {
      if (/<\/svg>/i.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end < 0) continue; // no closing tag in range
    out.push({ start: i, end, kind: 'svg', source: lines.slice(i, end + 1).join('\n') });
    i = end;
  }

  return out;
}

/** Read the terminal's whole buffer as trimmed plain-text lines (absolute index). */
export function readBufferLines(term: Terminal): string[] {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out;
}

let mermaidReady = false;
function initMermaid() {
  if (mermaidReady) return;
  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
  mermaidReady = true;
}
let seq = 0;

/** The close fn of the currently-open artifact modal (at most one). Lets the layer
 *  shut it on dispose — otherwise switching sessions while zoomed would leave an
 *  orphaned full-screen overlay (and leaked window listeners) covering the app. */
let closeActiveModal: (() => void) | null = null;

/** Open a rendered artifact (the SVG or <img> inside a cover card) in a full-screen
 *  overlay with wheel-zoom and drag-pan. The content is MOVED into the overlay and
 *  restored on close — cloning an SVG would duplicate its internal ids and break
 *  marker/arrowhead references in both copies. */
function openArtifactModal(card: HTMLElement) {
  const content = card.firstElementChild as HTMLElement | null;
  if (!content) return;
  closeActiveModal?.(); // replace any modal already open

  const backdrop = document.createElement('div');
  backdrop.className = 'xterm-artifact-modal';
  const stage = document.createElement('div');
  stage.className = 'xterm-artifact-modal__stage';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'xterm-artifact-modal__close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close');

  const controls = document.createElement('div');
  controls.className = 'xterm-artifact-modal__controls';
  const mkBtn = (label: string, title: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  };
  const btnOut = mkBtn('−', 'Zoom out');
  const btnReset = mkBtn('⟳', 'Reset zoom & position');
  const btnIn = mkBtn('+', 'Zoom in');
  controls.append(btnOut, btnReset, btnIn);

  stage.appendChild(content); // move, don't clone
  backdrop.append(stage, closeBtn, controls);
  document.body.appendChild(backdrop);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const apply = () => {
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  // Zoom by `ratio` while keeping the screen point (px, py) fixed. The stage's
  // transform-origin is its centre, so its rect centre moves only by (tx, ty).
  const zoomAt = (px: number, py: number, ratio: number) => {
    const next = Math.min(20, Math.max(0.2, scale * ratio));
    const r = next / scale;
    if (r === 1) return;
    const rect = stage.getBoundingClientRect();
    tx += (px - (rect.left + rect.width / 2)) * (1 - r);
    ty += (py - (rect.top + rect.height / 2)) * (1 - r);
    scale = next;
    apply();
  };
  btnIn.addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25));
  btnOut.addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.25));
  btnReset.addEventListener('click', () => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  });

  // Mouse wheel + touchpad pinch that arrives as ctrl+wheel.
  const onWheel = (e: WheelEvent) => {
    e.preventDefault(); // also blocks the browser's own pinch/ctrl-wheel page zoom
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.02 : 0.0015)));
  };

  // Pointer gestures — one pointer pans, two pointers pinch-zoom. Covers
  // touchscreens and touchpads that report the gesture as pointers (where a plain
  // wheel handler catches nothing). `touch-action: none` on the backdrop lets these
  // reach us instead of the browser zooming the page.
  const pts = new Map<number, { x: number; y: number }>();
  let panX = 0;
  let panY = 0;
  let pinchDist = 0;
  let pinchMidX = 0;
  let pinchMidY = 0;
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault(); // stop native drag / text-selection on the SVG swallowing the pan
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      panX = e.clientX;
      panY = e.clientY;
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchMidX = (a.x + b.x) / 2;
      pinchMidY = (a.y + b.y) / 2;
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (pinchDist > 0) {
        zoomAt(midX, midY, dist / pinchDist);
        tx += midX - pinchMidX; // two-finger pan
        ty += midY - pinchMidY;
        apply();
      }
      pinchDist = dist;
      pinchMidX = midX;
      pinchMidY = midY;
    } else {
      tx += e.clientX - panX;
      ty += e.clientY - panY;
      panX = e.clientX;
      panY = e.clientY;
      apply();
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchDist = 0;
    if (pts.size === 1) {
      const [p] = [...pts.values()];
      panX = p.x;
      panY = p.y;
    }
  };

  const close = () => {
    backdrop.removeEventListener('wheel', onWheel);
    stage.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('keydown', onKey, true);
    card.appendChild(content); // restore into the terminal cover
    backdrop.remove();
    if (closeActiveModal === close) closeActiveModal = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Capture phase + stopPropagation so Esc closes the modal instead of reaching
    // the terminal underneath (which would forward it to the PTY / interrupt Claude).
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  backdrop.addEventListener('wheel', onWheel, { passive: false });
  backdrop.addEventListener('dragstart', (e) => e.preventDefault()); // belt-and-braces vs native SVG drag
  stage.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKey, true); // capture, to beat the terminal to Esc
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  closeActiveModal = close;
  apply();
}

interface Covered {
  key: string;
  marker: import('@xterm/xterm').IMarker;
  dispose: () => void;
}

export interface InlineArtifactLayer {
  /** Re-scan the buffer and cover any newly-detected, not-yet-covered block. */
  scan(): void;
  /** Tear down every decoration (call on terminal dispose). */
  dispose(): void;
}

export interface InlineArtifactDeps {
  /** Resolve an image path (as printed in the tool block) to a browser-loadable
   *  URL, or null if it can't be served. */
  resolveImageSrc?: (path: string) => string | null;
}

/** Stable identity for a block — so a failed render isn't retried on every scan,
 *  and a reflowed block isn't mistaken for a new one. */
function keyOf(b: ArtifactBlock): string {
  if (b.kind === 'image') return `image:${b.path}`;
  if (b.kind === 'svg') return `svg:${b.source}`;
  return `mermaid:${b.source}`;
}

/** Attach an inline-artifact layer to a terminal. Scanning is caller-driven
 *  (debounced after writes) so the layer holds no timers of its own. */
export function createInlineArtifactLayer(term: Terminal, deps: InlineArtifactDeps = {}): InlineArtifactLayer {
  const covered: Covered[] = [];
  // Blocks whose render failed — an unparseable diagram, an unloadable image, or a
  // false positive. On failure we un-cover (reveal the underlying text) and record
  // the key here so the next scan doesn't just re-cover and re-fail.
  const failed = new Set<string>();

  // Pixel size of one cell, derived from the rendered screen (xterm exposes no
  // public cell-metrics API). Recomputed per cover so font-size changes are honoured.
  function cell(): { w: number; h: number } | null {
    const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    if (!r.height || !term.cols || !term.rows) return null;
    return { w: r.width / term.cols, h: r.height / term.rows };
  }

  // A block is already handled if a LIVE marker sits inside it — the marker moves
  // with its content through reflow, so a shifted block is not re-covered. If the
  // marker was disposed (buffer clear), none is live inside and we re-cover.
  function alreadyCovered(b: ArtifactBlock): boolean {
    return covered.some((c) => !c.marker.isDisposed && c.marker.line >= b.start && c.marker.line <= b.end);
  }

  function drop(entry: Covered) {
    entry.dispose();
    const i = covered.indexOf(entry);
    if (i >= 0) covered.splice(i, 1);
  }

  function cover(b: ArtifactBlock) {
    const buf = term.buffer.active;
    const offset = b.start - (buf.baseY + buf.cursorY);
    const marker = term.registerMarker(offset);
    if (!marker) return;
    const rows = b.end - b.start + 1;
    const dec = term.registerDecoration({ marker, width: term.cols, height: rows, layer: 'top' });
    if (!dec) {
      marker.dispose();
      return;
    }
    const entry: Covered = { key: keyOf(b), marker, dispose: () => dec.dispose() };
    // Graceful degradation: on a render failure, remove the cover so the source
    // text shows through, and remember the key so we don't retry it.
    const onFail = () => {
      failed.add(entry.key);
      drop(entry);
    };
    const c = cell();
    dec.onRender((el) => {
      el.classList.add('xterm-inline-artifact');
      if (el.querySelector('.xterm-inline-artifact__card')) return; // build once
      const card = document.createElement('div');
      card.className = 'xterm-inline-artifact__card';
      if (c) {
        card.style.width = term.cols * c.w + 'px';
        card.style.height = rows * c.h + 'px';
      }
      if (b.kind === 'image') renderImage(card, b, onFail);
      else if (b.kind === 'svg') renderInlineSvg(card, b.source, onFail);
      else renderMermaid(card, b.source, onFail);
      // Click the artifact to open it zoomable/pannable full-screen.
      card.addEventListener('click', () => openArtifactModal(card));
      el.appendChild(card);
    });
    marker.onDispose(() => {
      const i = covered.indexOf(entry);
      if (i >= 0) covered.splice(i, 1);
    });
    covered.push(entry);
  }

  function renderMermaid(card: HTMLElement, source: string, onFail: () => void) {
    initMermaid();
    mermaid
      .render(`term-mmd-${seq++}`, source)
      .then(({ svg }) => {
        card.innerHTML = svg;
      })
      .catch((e) => {
        // Unparseable (or over-captured / false positive) → reveal the source.
        console.error('[inline-artifact] mermaid render failed:', e);
        onFail();
      });
  }

  function renderInlineSvg(card: HTMLElement, source: string, onFail: () => void) {
    card.innerHTML = source; // the markup is the image
    if (!card.querySelector('svg')) onFail(); // didn't parse as SVG → reveal the source
  }

  function renderImage(card: HTMLElement, b: ArtifactBlock, onFail: () => void) {
    const src = b.path && deps.resolveImageSrc ? deps.resolveImageSrc(b.path) : null;
    if (!src) {
      onFail();
      return;
    }
    const img = document.createElement('img');
    img.className = 'xterm-inline-artifact__img';
    img.alt = '';
    img.onerror = onFail; // unloadable (truncated path, missing file) → reveal the tool block
    img.src = src;
    card.appendChild(img);
  }

  return {
    scan() {
      const blocks = detectArtifacts(readBufferLines(term));
      for (const b of blocks) {
        if (failed.has(keyOf(b))) continue;
        if (b.kind === 'image' && !(b.path && deps.resolveImageSrc)) continue; // no way to load it yet
        if (alreadyCovered(b)) continue;
        cover(b);
      }
    },
    dispose() {
      closeActiveModal?.(); // close a zoomed artifact so it isn't orphaned on unmount
      for (const c of covered) c.dispose();
      covered.length = 0;
    },
  };
}
