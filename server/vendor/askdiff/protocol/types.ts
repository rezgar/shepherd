import type { z } from "zod";
import type {
  AskMessageSchema,
  CancelMessageSchema,
  ChunkMessageSchema,
  ClientMessageSchema,
  DiffFileSchema,
  DiffHunkSchema,
  DiffMessageSchema,
  DiffRequestMessageSchema,
  DoneMessageSchema,
  ErrorMessageSchema,
  HelloMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
  ServerMessageSchema,
  SessionMessageSchema,
} from "./schemas.js";

export type DiffHunk = z.infer<typeof DiffHunkSchema>;
export type DiffFile = z.infer<typeof DiffFileSchema>;

export type AskMessage = z.infer<typeof AskMessageSchema>;
export type CancelMessage = z.infer<typeof CancelMessageSchema>;
export type DiffRequestMessage = z.infer<typeof DiffRequestMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type DiffMessage = z.infer<typeof DiffMessageSchema>;
export type ChunkMessage = z.infer<typeof ChunkMessageSchema>;
export type DoneMessage = z.infer<typeof DoneMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
