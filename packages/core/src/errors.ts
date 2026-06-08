export interface AtelierError {
  code: string;
  message: string;
  details?: unknown;
}

export class AtelierCoreError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function invalidArguments(message: string): AtelierCoreError {
  return new AtelierCoreError("invalid_arguments", message);
}
