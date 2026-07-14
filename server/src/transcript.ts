import { readFile } from 'node:fs/promises';

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface ChatTool {
  name: string;
  detail: string;
  /** Set only for AskUserQuestion — the structured questions the agent is
   *  asking the user, rendered as a card instead of a bare tool chip. */
  questions?: AskQuestion[];
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

export interface SubagentInfo {
  agentId: string;
  description: string;
  dispatchedAt: number;
}

export interface Transcript {
  type: 'transcript';
  sessionId: string;
  file: string;
  messages: ChatMsg[];
  /** Subagents this session dispatched that haven't reported a terminal
   *  status yet (no matching <task-notification> seen). */
  activeSubagents: SubagentInfo[];
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

// Matches the file-path notes sender.ts prepends for pasted images (there's no
// image-attachment flag for `claude -p`, so the real transcript only ever has
// a text pointer to the temp file — resolve it back to an actual image here).
const PASTE_NOTE_RE = /^\[Pasted image \d+ — read this file to view it: (.+?)\]\n?/gm;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

async function resolvePastedImages(text: string): Promise<{ text: string; images: string[] }> {
  const paths = [...text.matchAll(PASTE_NOTE_RE)].map((m) => m[1]);
  if (!paths.length) return { text, images: [] };
  const images: string[] = [];
  for (const p of paths) {
    try {
      const buf = await readFile(p);
      const ext = p.split('.').pop()?.toLowerCase() ?? '';
      images.push(`data:${MIME_BY_EXT[ext] ?? 'image/png'};base64,${buf.toString('base64')}`);
    } catch {
      // temp file gone or unreadable — skip it, don't break the rest of the message
    }
  }
  return { text: text.replace(PASTE_NOTE_RE, '').replace(/^\n+/, ''), images };
}

const TASK_ID_RE = /<task-id>(.+?)<\/task-id>/;

function isSubagentDispatch(name: string): boolean {
  return /task|agent/i.test(name);
}

/** Pull the structured questions out of an AskUserQuestion tool call so the
 *  UI can render them, instead of showing an empty "AskUserQuestion" chip. */
function extractQuestions(name: string, input: any): AskQuestion[] | undefined {
  if (name !== 'AskUserQuestion' || !Array.isArray(input?.questions)) return undefined;
  const questions: AskQuestion[] = [];
  for (const q of input.questions) {
    if (!q || typeof q.question !== 'string') continue;
    const options: AskOption[] = Array.isArray(q.options)
      ? q.options
          .filter((o: any) => o && typeof o.label === 'string')
          .map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined }))
      : [];
    questions.push({
      header: typeof q.header === 'string' ? q.header : undefined,
      question: q.question,
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return questions.length ? questions : undefined;
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

  // Subagent bookkeeping: tool_use.id -> its dispatch, filled in with the
  // agentId once the launch's tool_result reports it, then dropped from
  // "active" once a matching <task-notification> reports a terminal status.
  const dispatches = new Map<string, { description: string; ts: number; agentId?: string }>();
  const finishedAgentIds = new Set<string>();

  // Read a point-in-time snapshot rather than streaming to EOF — the transcript
  // of a live session is appended to continuously, and a following stream would
  // never resolve while the agent is mid-response.
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { type: 'transcript', sessionId, file, messages: [], activeSubagents: [] };
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

    if (o.type === 'queue-operation') {
      // The <task-notification> is written here the instant a subagent
      // finishes — it's only *sometimes* also promoted to a real "user" turn
      // (origin.kind === 'task-notification', handled below) once it's
      // actually delivered into the conversation. Some notifications sit in
      // the queue and never get promoted at all (e.g. the session moved on
      // before it was next read), so this queue-operation record is the one
      // source that's always there — check it first.
      const text = typeof o.content === 'string' ? o.content : '';
      const m = TASK_ID_RE.exec(text);
      if (m) finishedAgentIds.add(m[1]);
      continue;
    }

    if (o.type === 'user') {
      if (o.origin?.kind === 'task-notification') {
        const text = typeof o.message?.content === 'string' ? o.message.content : '';
        const m = TASK_ID_RE.exec(text);
        if (m) finishedAgentIds.add(m[1]);
        continue; // synthetic — never render it as something the person said
      }
      // System-injected content also rides in as "user" events (isMeta) but
      // nothing the actual person typed — never render it as if they said it.
      if (o.isMeta === true) continue;
      const content = o.message?.content;
      const toolResult = Array.isArray(content) ? content.find((c: any) => c?.type === 'tool_result') : null;
      if (toolResult) {
        // A subagent dispatch's tool_result reports its agentId here (not
        // nested in the content block) — that's how we find its own file.
        const agentId = o.toolUseResult?.agentId;
        const dispatch = agentId ? dispatches.get(toolResult.tool_use_id) : undefined;
        if (dispatch) dispatch.agentId = agentId;
        continue; // tool results arrive as "user" events — don't render them as user turns
      }
      const { text: rawText, images: inlineImages } = textAndImages(content);
      if (!rawText.trim() && !inlineImages.length) continue;
      const { text, images: pastedImages } = await resolvePastedImages(rawText);
      if (!text.trim() && !inlineImages.length && !pastedImages.length) continue;
      msgs.push({ id: o.uuid ?? `u${i++}`, role: 'user', text, tools: [], images: [...inlineImages, ...pastedImages], ts });
    } else if (o.type === 'assistant') {
      const content = o.message?.content;
      const { text, images } = textAndImages(content);
      const toolUses: any[] = Array.isArray(content) ? content.filter((c: any) => c?.type === 'tool_use') : [];
      const tools: ChatTool[] = toolUses.map((c) => {
        const name = String(c.name ?? '');
        return { name, detail: toolDetail(name, c.input ?? {}), questions: extractQuestions(name, c.input ?? {}) };
      });
      for (const c of toolUses) {
        if (!c.id || !isSubagentDispatch(String(c.name ?? ''))) continue;
        const description =
          typeof c.input?.description === 'string' && c.input.description.trim()
            ? c.input.description.trim()
            : String(c.name ?? 'subagent');
        dispatches.set(c.id, { description, ts });
      }
      if (!text.trim() && !tools.length && !images.length) continue;
      msgs.push({ id: o.uuid ?? `a${i++}`, role: 'assistant', text, tools, images, ts });
    }
  }

  const activeSubagents: SubagentInfo[] = [...dispatches.values()]
    .filter((d): d is { description: string; ts: number; agentId: string } => !!d.agentId && !finishedAgentIds.has(d.agentId))
    .map((d) => ({ agentId: d.agentId, description: d.description, dispatchedAt: d.ts }));

  // Return the full parsed list; the WebSocket layer decides the window to send.
  return { type: 'transcript', sessionId, file, messages: msgs, activeSubagents };
}
