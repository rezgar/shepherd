import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMsg, Transcript } from '../types';
import { Mermaid } from './Mermaid';

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

function Message({ msg }: { msg: ChatMsg }) {
  return (
    <div className={`msg msg--${msg.role}`}>
      <div className="msg__role">{msg.role === 'user' ? 'You' : 'Agent'}</div>
      {msg.text && (
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {msg.text}
          </ReactMarkdown>
        </div>
      )}
      {msg.images.map((src, i) => (
        <img key={i} className="msg__img" src={src} alt="" />
      ))}
      {msg.tools.length > 0 && (
        <div className="msg__tools">
          {msg.tools.map((t, i) => (
            <span key={i} className="toolchip" title={t.detail}>
              {t.name}
              {t.detail ? `: ${t.detail}` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatTranscript({ transcript }: { transcript: Transcript | null }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [transcript]);

  if (!transcript) return <div className="chat chat--empty">Loading conversation…</div>;
  if (!transcript.messages.length) return <div className="chat chat--empty">No messages yet.</div>;

  return (
    <div className="chat">
      {transcript.messages.map((m) => (
        <Message key={m.id} msg={m} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
