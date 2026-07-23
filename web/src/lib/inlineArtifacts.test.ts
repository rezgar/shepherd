import { describe, expect, it } from 'vitest';
import { detectArtifacts } from './inlineArtifacts';

const lines = (s: string) => s.split('\n');

describe('detectArtifacts — mermaid', () => {
  it('finds a fenced flowchart and spans the whole block', () => {
    const buf = lines(
      [
        'Here is the flow:',
        '```mermaid',
        'flowchart TD',
        '  A[Start] --> B{Ok?}',
        '  B -->|yes| C[Done]',
        '  B -->|no| A',
        '```',
        'That covers it.',
      ].join('\n'),
    );
    const [block, ...rest] = detectArtifacts(buf);
    expect(rest).toHaveLength(0);
    expect(block.kind).toBe('mermaid');
    // opening fence folded in (line 1) through the closing fence (line 6)
    expect(block.start).toBe(1);
    expect(block.end).toBe(6);
    expect(block.source).toContain('flowchart TD');
  });

  it('walks past blank lines inside the diagram', () => {
    const buf = lines(
      [
        'flowchart TD',
        '  A --> B',
        '',
        '  B --> C',
        '',
        '  C --> D',
        '',
        'This prose ends the block.',
      ].join('\n'),
    );
    const [block] = detectArtifacts(buf);
    expect(block.start).toBe(0);
    expect(block.end).toBe(5); // last source line, not the first blank
  });

  it('ends the block at prose when there is no closing fence', () => {
    const buf = lines(['sequenceDiagram', '  Alice->>Bob: hi', '  Bob-->>Alice: yo', 'Now some explanation follows.'].join('\n'));
    const [block] = detectArtifacts(buf);
    expect(block.end).toBe(2);
  });

  it('stops at trailing prose even when the buffer indents it', () => {
    // Claude Code indents the paragraph after a code block; the diagram must not
    // swallow it (regression: an over-captured paragraph is a mermaid parse error).
    const buf = lines(
      ['flowchart TD', '  A --> B', '  B --> C', '', '  The flow covers the main paths and much more.'].join('\n'),
    );
    const [block] = detectArtifacts(buf);
    expect(block.end).toBe(2); // last arrow line, not the indented prose
    expect(block.source).not.toContain('main paths');
  });

  it('captures a sequence diagram including actor/participant/alt/end declarations', () => {
    const buf = lines(
      [
        'sequenceDiagram',
        '    actor User',
        '    participant UI as Frontend',
        '',
        '    User->>UI: Enter creds',
        '    alt Invalid',
        '        UI-->>User: error',
        '    else Valid',
        '        UI->>API: login',
        '    end',
        '',
        'This covers the main path (bad input, wrong password).',
      ].join('\n'),
    );
    const [block, ...rest] = detectArtifacts(buf);
    expect(rest).toHaveLength(0);
    expect(block.start).toBe(0);
    expect(block.end).toBe(9); // the 'end' line — not the trailing prose (which has parens)
    expect(block.source).toContain('participant UI');
    expect(block.source).not.toContain('bad input');
  });

  it('does not fire on ordinary prose or non-mermaid code', () => {
    const buf = lines(
      [
        'This is a normal sentence about a graph of results.',
        '```ts',
        'const x = compute(graph);',
        'return x.flowchart;',
        '```',
        'Nothing to render here.',
      ].join('\n'),
    );
    expect(detectArtifacts(buf)).toHaveLength(0);
  });

  it('detects two separate diagrams', () => {
    const buf = lines(['graph LR', '  A --> B', '', 'text', '', 'flowchart TD', '  X --> Y', ''].join('\n'));
    const blocks = detectArtifacts(buf);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.start)).toEqual([0, 5]);
  });
});

describe('detectArtifacts — image tool blocks', () => {
  it('covers a Write(<svg>) block and captures the path', () => {
    const buf = lines(
      [
        'Here is a cat:',
        '● Write(~/proj/cat.svg)',
        '  ⎿ Wrote 48 lines to cat.svg',
        '     1 <svg viewBox="0 0 400 400">',
        '     2 <rect width="400" height="400"/>',
        '     … +38 lines (ctrl+o to expand)',
        '',
        '● A little orange tabby.',
      ].join('\n'),
    );
    const imgs = detectArtifacts(buf).filter((b) => b.kind === 'image');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].path).toBe('~/proj/cat.svg');
    expect(imgs[0].start).toBe(1); // the Write line
    expect(imgs[0].end).toBe(5); // through the "+38 lines" preview, not the next bullet
  });

  it('detects Read(<png>) and ignores non-image tools', () => {
    const buf = lines(['● Read(/tmp/photo.png)', '  ⎿ [image]', '● Bash(ls -la)'].join('\n'));
    const imgs = detectArtifacts(buf).filter((b) => b.kind === 'image');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].path).toBe('/tmp/photo.png');
    expect(imgs[0].end).toBe(1);
  });

  it('does not treat a non-image Write as an image', () => {
    const buf = lines(['● Write(src/index.ts)', '  ⎿ Wrote 10 lines'].join('\n'));
    expect(detectArtifacts(buf).filter((b) => b.kind === 'image')).toHaveLength(0);
  });

  it('does not fire on a tool name mentioned mid-sentence', () => {
    const buf = lines(['I will use Read(diagram.png) to load it, then summarise.', '  more indented prose'].join('\n'));
    expect(detectArtifacts(buf).filter((b) => b.kind === 'image')).toHaveLength(0);
  });
});
