/** How long a one-turn, no-tool session is left alone before it counts as
 *  machine-issued. A session that was just spawned looks EXACTLY like a
 *  finished `aic.sh` one — one queued prompt, no tool use — because nothing
 *  has happened in it yet. Without this window, "+ new session" would appear
 *  to do nothing: the card would be filtered out the instant it was created
 *  and only reappear once the model answered. Ten minutes is far longer than
 *  any real turn takes to produce its first tool call or reply, and these
 *  sessions are never urgent to hide. */
export const MACHINE_ISSUED_GRACE_MS = 10 * 60_000;

export interface SessionShape {
  /** Number of user turns in the transcript. */
  userTurns: number;
  /** Number of `tool_use` blocks across all assistant turns. */
  toolUses: number;
  /** Timestamp of the last event in the transcript (ms). */
  lastActivity: number;
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
  // Zero turns is not "machine-issued", it is "empty" — a transcript with no
  // conversation in it at all. Leave it alone.
  if (s.userTurns !== 1) return false;
  if (s.toolUses > 0) return false;
  return now - s.lastActivity > MACHINE_ISSUED_GRACE_MS;
}
