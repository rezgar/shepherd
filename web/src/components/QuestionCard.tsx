import { useState } from 'react';
import type { ChatTool } from '../types';

/** Renders an agent's AskUserQuestion. When `interactive` (the question is the
 *  latest thing in the transcript, i.e. the agent is waiting on it), each
 *  option is selectable and a free-form box lets you add a comment or type your
 *  own answer ("other"); "Send answer" composes the choice + comment and sends
 *  it back into the session as a normal reply. Older/answered questions render
 *  read-only. */
export function QuestionCard({
  tool,
  interactive,
  onAnswer,
}: {
  tool: ChatTool;
  interactive: boolean;
  onAnswer: (text: string) => void;
}) {
  const questions = tool.questions!;
  const [selection, setSelection] = useState<Record<number, string[]>>({});
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelection((prev) => {
      const cur = prev[qi] ?? [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : cur.includes(label)
          ? []
          : [label];
      return { ...prev, [qi]: next };
    });
  };

  const anySelected = Object.values(selection).some((s) => s.length);
  const canSend = interactive && !sent && (anySelected || comment.trim().length > 0);

  const send = () => {
    if (!canSend) return;
    const parts: string[] = [];
    questions.forEach((q, qi) => {
      const sel = selection[qi] ?? [];
      if (!sel.length) return;
      parts.push(questions.length > 1 ? `${q.header ?? q.question}: ${sel.join(', ')}` : sel.join(', '));
    });
    const answer = [parts.join('\n'), comment.trim()].filter(Boolean).join('\n\n');
    onAnswer(answer);
    setSent(true);
  };

  const disabled = !interactive || sent;

  return (
    <div className="qcard">
      <div className="qcard__label">{sent ? 'Answer sent' : 'Asked you'}</div>
      {questions.map((q, qi) => (
        <div className="qcard__q" key={qi}>
          <div className="qcard__question">{q.question}</div>
          {q.options.length > 0 && (
            <ul className="qcard__opts">
              {q.options.map((o, oi) => {
                const on = (selection[qi] ?? []).includes(o.label);
                const mark = on ? (q.multiSelect ? '☑' : '◉') : q.multiSelect ? '☐' : '○';
                return (
                  <li key={oi}>
                    <button
                      type="button"
                      className={`qcard__opt${on ? ' qcard__opt--on' : ''}`}
                      disabled={disabled}
                      onClick={() => toggle(qi, o.label, !!q.multiSelect)}
                    >
                      <span className="qcard__opt-mark">{mark}</span>
                      <span className="qcard__opt-body">
                        <span className="qcard__opt-label">{o.label}</span>
                        {o.description && <span className="qcard__opt-desc">{o.description}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
      {interactive && !sent && (
        <div className="qcard__answer">
          <textarea
            className="qcard__comment"
            placeholder="Add a comment, or type your own answer…"
            value={comment}
            rows={1}
            onChange={(e) => setComment(e.target.value)}
          />
          <button className="qcard__send" onClick={send} disabled={!canSend}>
            Send answer
          </button>
        </div>
      )}
    </div>
  );
}
