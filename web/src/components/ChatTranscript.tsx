import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMsg, ChatTool } from '../types';
import { Mermaid } from './Mermaid';
import { QuestionCard } from './QuestionCard';
import { ToolRow } from './ToolRow';

const mdComponents = {
  code({ className, children, ...props }: any) {
    const lang = /language-(\w+)/.exec(className ?? '')?.[1];
    if (lang === 'mermaid') return <Mermaid chart={String(children).replace(/\n$/, '')} />;
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ children, ...props }: any) {
    return (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

// A turn is a run of consecutive messages from the same actor — one "You"/
// "Agent" header instead of repeating it for every tool call. A pending echo
// always stands alone so its "sending…" tag reads clearly.
interface Turn {
  key: string;
  role: ChatMsg['role'];
  pending: boolean;
  msgs: ChatMsg[];
}

function groupTurns(messages: ChatMsg[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const last = turns[turns.length - 1];
    if (last && last.role === m.role && !last.pending && !m.pending) last.msgs.push(m);
    else turns.push({ key: m.id, role: m.role, pending: !!m.pending, msgs: [m] });
  }
  return turns;
}

// A turn's content, flattened in reading order. Consecutive tool calls are
// collapsed into a single grouped list rather than scattered one-per-message.
type Part =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'image'; key: string; src: string }
  | { kind: 'question'; key: string; tool: ChatTool; msgId: string }
  | { kind: 'tools'; key: string; tools: ChatTool[] };

function partsOfTurn(turn: Turn): Part[] {
  const parts: Part[] = [];
  turn.msgs.forEach((m, mi) => {
    if (m.text) parts.push({ kind: 'text', key: `${m.id}-t`, text: m.text });
    m.images.forEach((src, i) => parts.push({ kind: 'image', key: `${m.id}-img${i}`, src }));
    for (const t of m.tools) {
      if (t.questions?.length) {
        parts.push({ kind: 'question', key: `${m.id}-q`, tool: t, msgId: m.id });
      } else {
        // merge into the trailing tools part so consecutive calls list together
        const prev = parts[parts.length - 1];
        if (prev?.kind === 'tools') prev.tools.push(t);
        else parts.push({ kind: 'tools', key: `${m.id}-tools${mi}`, tools: [t] });
      }
    }
  });
  return parts;
}

function TurnBlock({
  turn,
  lastMsgId,
  answerable,
  onAnswer,
}: {
  turn: Turn;
  lastMsgId: string;
  answerable: boolean;
  onAnswer: (text: string) => void;
}) {
  const parts = partsOfTurn(turn);
  return (
    <div className={`turn turn--${turn.role}${turn.pending ? ' turn--pending' : ''}`}>
      <div className="turn__role">
        {turn.role === 'user' ? 'You' : 'Agent'}
        {turn.pending && <span className="msg__pending-tag">sending…</span>}
      </div>
      {parts.map((p) => {
        if (p.kind === 'text')
          return (
            <div className="md" key={p.key}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {p.text}
              </ReactMarkdown>
            </div>
          );
        if (p.kind === 'image') return <img key={p.key} className="msg__img" src={p.src} alt="" />;
        if (p.kind === 'question')
          return (
            <QuestionCard
              key={p.key}
              tool={p.tool}
              interactive={answerable && p.msgId === lastMsgId}
              onAnswer={onAnswer}
            />
          );
        return (
          <div className="toolgroup" key={p.key}>
            {p.tools.map((t, i) => (
              <ToolRow key={i} tool={t} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function ChatTranscript({
  messages,
  hasMore,
  onLoadMore,
  onAnswer,
  answerable = true,
}: {
  messages: ChatMsg[] | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onAnswer: (text: string) => void;
  /** False for read-only views (e.g. the subagent modal) — no question is answerable. */
  answerable?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const pinBottom = useRef(true);
  const olderPrevHeight = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (olderPrevHeight.current != null) {
      // older messages were prepended — keep the viewport where it was
      el.scrollTop += el.scrollHeight - olderPrevHeight.current;
      olderPrevHeight.current = null;
    } else if (pinBottom.current) {
      endRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && hasMore && olderPrevHeight.current == null) {
      olderPrevHeight.current = el.scrollHeight;
      onLoadMore();
    }
  };

  if (messages == null) return <div className="chat chat--empty">Loading conversation…</div>;
  if (!messages.length) return <div className="chat chat--empty">No messages yet.</div>;

  // Only the latest message's question is answerable — that's the one the agent
  // is actually waiting on; older ones render read-only.
  const lastMsgId = messages[messages.length - 1].id;
  const turns = groupTurns(messages);
  return (
    <div className="chat" ref={scrollRef} onScroll={onScroll}>
      {hasMore && <div className="chat__more">↑ scroll for earlier messages</div>}
      {turns.map((t) => (
        <TurnBlock key={t.key} turn={t} lastMsgId={lastMsgId} answerable={answerable} onAnswer={onAnswer} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
