export const PROJECT_NAME = 'askdiff';
export const PROJECT_NAME_UPPER_CASE = PROJECT_NAME.toUpperCase();

export const DEFAULT_PORT = 7837;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60_000;

// How long streamAnswer will wait for the NEXT byte of `claude -p --resume`
// output before giving up on a stalled ask. Reset on every chunk received,
// so this bounds silence, not total answer length.
export const ASK_IDLE_TIMEOUT_MS = 60_000;
