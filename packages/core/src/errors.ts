export interface AtelierError {
  code: string;
  message: string;
}

export class AtelierCoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function invalidArguments(message: string): AtelierCoreError {
  return new AtelierCoreError("invalid_arguments", message);
}
