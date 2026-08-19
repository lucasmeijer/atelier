import type { JsonObject } from "./json.ts";

export interface AtelierError {
  code: string;
  message: string;
  details?: JsonObject;
}

export class AtelierCoreError extends Error {
  readonly code: string;
  readonly details?: JsonObject;

  constructor(code: string, message: string, details?: JsonObject) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function invalidArguments(message: string): AtelierCoreError {
  return new AtelierCoreError("invalid_arguments", message);
}
