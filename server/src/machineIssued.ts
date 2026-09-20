import type { AgentState } from './types.js';

/** How long a one-turn, no-tool session is left alone before it counts as
 *  machine-issued.
 *
 *  Two different cases have to survive this window, and the second is what
 *  makes it hours rather than minutes:
 *
 *  1. A session that was just spawned looks EXACTLY like a finished `aic.sh`
 *     one — one prompt, no tool use — because nothing has happened in it yet.
 *     Minutes would cover this.
 *  2. A genuine one-question session answered in prose, with no tool call,
 *     that the person then walked away from. Nothing about its shape ever
 *     distinguishes it from a machine-issued one; only elapsed time does, and
 *     an hour away from the keyboard is ordinary.
 *
 *  There is no "show hidden" affordance in the UI, so a wrongly-hidden
 *  session is unrecoverable, while a wrongly-shown one is merely clutter for
 *  a few more hours. Six hours resolves that asymmetry in the recoverable
 *  direction and still clears the `aic.sh` backlog the same working day. */
export const MACHINE_ISSUED_GRACE_MS = 6 * 3_600_000;

export interface SessionShape {
  /** Number of user turns in the transcript. */
  userTurns: number;
  /** Number of `tool_use` blocks across all assistant turns. */
  toolUses: number;
  /** Timestamp of the last event in the transcript (ms). */
  lastActivity: number;
  /** The session's classified state. Anything other than `idle` is live
   *  evidence a person or a running turn is involved. */
  state: AgentState;
  /** Prompts waiting to be sent. */
  queued: number;
}

/** Whether a session was issued by a tool rather than a person, and so is
 *  noise as an agent card.
 *
 *  The signal is shape, not prompt text. Matching on the commit-message
 *  prompt itself would hardcode another tool's wording (and `aic.sh` is not
 *  the only such caller — the `.`-prompt `sdk-cli` sessions under
 *  `C:\Windows\System32` have the identical shape and an entirely different
 *  prompt). One turn with no tool use means: something asked a single
 *  question, took the answer, and left. Nobody can resume it usefully and
 *  nothing is running in it.
 *
 *  Deliberately NOT keyed on `everHadRemoteControl`, which was the obvious
 *  first guess and is wrong in both directions on real data: an observed
 *  `aic.sh` transcript carries `bridge_status` events (so it would survive
 *  the filter), while a genuine session shepherd itself spawned carries none
 *  (so it would be hidden). Remote Control says whether a phone COULD reach
 *  a session, which is a different question from whether a person was ever
 *  in it.
 *
 *  Conservative on purpose — every ambiguous case resolves to "show it". A
 *  wrongly-hidden session is invisible and unrecoverable from the UI; a
 *  wrongly-shown one is merely clutter. */
export function isMachineIssued(s: SessionShape, now: number): boolean {
  // Live state beats every shape heuristic below. A session can be `working`
  // with a transcript that has not been written to for far longer than the
  // grace window — a long think, a slow MCP call, a long-running Bash — and
  // `needs-you` can be reached with no tool call at all, just a trailing
  // question in prose. Hiding either is the disappearing-card failure the
  // grace window was meant to prevent, and because this filter sits upstream
  // of restore (see scan.ts) it would also quietly drop such a session from
  // the restore set.
  if (s.state !== 'idle') return false;
  // Work explicitly lined up means somebody intends to use this session,
  // whatever its transcript looks like so far.
  if (s.queued > 0) return false;
  // Zero turns is not "machine-issued", it is "empty" — a transcript with no
  // conversation in it at all. Leave it alone.
  if (s.userTurns !== 1) return false;
  if (s.toolUses > 0) return false;
  return now - s.lastActivity > MACHINE_ISSUED_GRACE_MS;
}
