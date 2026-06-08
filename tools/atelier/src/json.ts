export interface AtelierError {
  code: string;
  message: string;
  details?: unknown;
}

export function writeSuccess<T>(result: T): void {
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

export function writeError(error: AtelierError): void {
  process.stderr.write(`${JSON.stringify({ ok: false, error })}\n`);
}

export class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function invalidArguments(message: string): CliError {
  return new CliError("invalid_arguments", message);
}
