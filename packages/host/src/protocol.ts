import type { HostMetricId } from "./diagnostics.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
export const hostSocketPath = "/run/atelier-host/control.sock";
export interface HostTerminal { id: string; title: string }
export interface HostMetric { id: HostMetricId; value: string; warning?: boolean }
export interface HostSection { title: string; text: string; error?: boolean }
export interface HostSample { sampledAt: string; durationMs: number; metrics: HostMetric[]; sections: HostSection[] }
export interface HostResults {
  list: HostTerminal[];
  create: HostTerminal;
  terminate: null;
  sample: HostSample;
}
export type HostResult = HostResults[keyof HostResults];
const terminalId = Type.String({ pattern: "^host-[a-f0-9-]{36}$" });
const requestSchema = Type.Union([
  Type.Object({ operation: Type.Literal("list") }),
  Type.Object({ operation: Type.Literal("create") }),
  Type.Object({ operation: Type.Literal("terminate"), id: terminalId }),
  Type.Object({ operation: Type.Literal("sample"), fresh: Type.Optional(Type.Boolean()) }),
  Type.Object({ operation: Type.Literal("attach"), id: terminalId, cols: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
]);
export type HostRequest = Static<typeof requestSchema>;
export type HostCommand = Exclude<HostRequest, { operation: "attach" }>;
export function parseHostRequest(line: string): HostRequest { return Value.Parse(requestSchema, JSON.parse(line)); }
export function parseHostInput(line: string): string { return Value.Parse(Type.String({ maxLength: 1024 * 1024 }), JSON.parse(line)); }
export type HostReply = { type: "result"; value: HostResult } | { type: "error"; message: string } | { type: "output"; data: string } | { type: "exit" };
export function validTerminalId(id: string): boolean { return /^host-[a-f0-9-]{36}$/.test(id); }
export function terminalSize(value: number | string | null | undefined, defaultValue: number): number { const n = Number(value); return Number.isInteger(n) && n > 0 && n <= 1000 ? n : defaultValue; }
