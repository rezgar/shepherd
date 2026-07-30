import type { WebSocket } from "ws";
import type { ServerMessage } from "../../protocol/index.js";
import type { ServerState } from "../index.js";

export function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
}

export function broadcast(state: ServerState, message: ServerMessage): void {
  for (const ws of state.clients) send(ws, message);
}
