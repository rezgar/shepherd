import { readFile } from 'node:fs/promises';

export interface ChatTool {
  name: string;
  detail: string;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  /** Markdown body (may contain mermaid fences, image links, etc.). */
  text: string;
  tools: ChatTool[];
  /** Inline images as data URIs or URLs. */
  images: string[];
  ts: number;
}

export interface Transcript {
  type: 'transcript';
  sessionId: string;
  file: string;
  messages: ChatMsg[];
}

function textAndImages(content: unknown): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of content as any[]) {
    if (!c) continue;
    if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    else if (c.type === 'image' && c.source) {
      if (c.source.type === 'base64' && c.source.data)
        images.push(`data:${c.source.media_type ?? 'image/png'};base64,${c.source.data}`);
      else if (c.source.type === 'url' && typeof c.source.url === 'string') images.push(c.source.url);
    }
  }
  return { text: texts.join('\n\n'), images };
}

function toolDetail(name: string, input: any): string {
  const n = name.toLowerCase();
  const base = (p: unknown) =>
    typeof p === 'string' ? (p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '') : '';
  if (typeof input?.description === 'string' && input.description.trim()) return input.description.trim();
  if (/edit|write|notebook/.test(n) && input?.file_path) return base(input.file_path);
  if (n.includes('read') && input?.file_path) return base(input.file_path);
  if ((n.includes('bash') || n.includes('powershell')) && input?.command)
    return String(input.command).slice(0, 140);
  if ((n.includes('grep') || n.includes('glob')) && input?.pattern) return String(input.pattern).slice(0, 80);
  return '';
}

/** Parse a session transcript into renderable chat messages (thinking + tool
 *  results are dropped; the last `limit` turns are kept). */
export async function parseTranscript(file: string, sessionId: string, limit = 80): Promise<Transcript> {
  const msgs: ChatMsg[] = [];
  let i = 0;

  // Read a point-in-time snapshot rather than streaming to EOF — the transcript
  // of a live session is appended to continuously, and a following stream would
  // never resolve while the agent is mid-response.
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { type: 'transcript', sessionId, file, messages: [] };
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : 0;

    if (o.type === 'user') {
      const content = o.message?.content;
      // Tool results arrive as "user" events — don't render them as user turns.
      if (Array.isArray(content) && content.some((c: any) => c?.type === 'tool_result')) continue;
      const { text, images } = textAndImages(content);
      if (!text.trim() && !images.length) continue;
      msgs.push({ id: o.uuid ?? `u${i++}`, role: 'user', text, tools: [], images, ts });
    } else if (o.type === 'assistant') {
      const content = o.message?.content;
      const { text, images } = textAndImages(content);
      const tools: ChatTool[] = Array.isArray(content)
        ? content
            .filter((c: any) => c?.type === 'tool_use')
            .map((c: any) => ({ name: String(c.name ?? ''), detail: toolDetail(String(c.name ?? ''), c.input ?? {}) }))
        : [];
      if (!text.trim() && !tools.length && !images.length) continue;
      msgs.push({ id: o.uuid ?? `a${i++}`, role: 'assistant', text, tools, images, ts });
    }
  }

  return { type: 'transcript', sessionId, file, messages: msgs.slice(-limit) };
}
