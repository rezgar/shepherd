import { useEffect, useState } from 'react';

// Same rotating-glyph convention as Claude Code's own "✽ Transfiguring…" indicator.
const SPIN_GLYPHS = ['✢', '✳', '✶', '✻', '✽'];

/** Cycles through the glyph rotation while `active`; frozen otherwise. */
export function useSpinGlyph(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((n) => (n + 1) % SPIN_GLYPHS.length), 130);
    return () => clearInterval(id);
  }, [active]);
  return SPIN_GLYPHS[i];
}
