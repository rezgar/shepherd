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

export type ArtifactKind = 'mermaid' | 'image';

export interface ArtifactBlock {
  /** Absolute buffer line index of the block's first row (inclusive). */
  start: number;
  /** Absolute buffer line index of the block's last row (inclusive). */
  end: number;
  kind: ArtifactKind;
  /** The block's text — mermaid source for diagrams; unused for images. */
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
// same way mermaid source is. The path is captured from inside the parens.
// Anchored to the start of the tool line (optionally after Claude Code's single
// bullet glyph) so a tool name MENTIONED mid-sentence in prose can't false-match —
// graceful degradation wouldn't catch that one, since a coincidentally-existing
// file would render successfully over the paragraph.
const IMG_TOOL = /^\s*(?:\S\s+)?(?:Write|Read|Edit|Update)\(\s*([^)]*?\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif))\s*\)/i;

/** Locate every diagram/image block in the buffer's plain text. Pure over the
 *  line array so it can be unit-tested without a live terminal. `lines[i]` is the
 *  text of absolute buffer line `i` (trailing whitespace already trimmed). */
export function detectArtifacts(lines: string[]): ArtifactBlock[] {
  const out: ArtifactBlock[] = [];

  // Image tool blocks: a Write/Read(<image file>) line, then its indented preview.
  // The block runs from the tool line through the last indented output row (the
  // "Wrote N lines" / file preview), ending at the next non-indented bullet/prose.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(IMG_TOOL);
    if (!m) continue;
    const path = m[1].trim();
    let end = i;
    for (let j = i + 1; j < lines.length && j < i + 60; j++) {
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

  content.classList.add('xterm-artifact-modal__content');
  stage.appendChild(content); // move, don't clone
  backdrop.append(stage, closeBtn);
  document.body.appendChild(backdrop);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const apply = () => {
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    scale = Math.min(20, Math.max(0.2, scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    apply();
  };
  const onDown = (e: MouseEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    e.preventDefault();
  };
  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
  };
  const onUp = () => {
    dragging = false;
  };
  const close = () => {
    backdrop.removeEventListener('wheel', onWheel);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey);
    content.classList.remove('xterm-artifact-modal__content');
    card.appendChild(content); // restore into the terminal cover
    backdrop.remove();
    if (closeActiveModal === close) closeActiveModal = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  backdrop.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('keydown', onKey);
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
  return b.kind === 'image' ? `image:${b.path}` : `mermaid:${b.source}`;
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
      .catch(onFail); // unparseable (or over-captured / false positive) → reveal source
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
