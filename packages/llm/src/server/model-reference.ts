export interface ModelRef { provider: string; id: string }

export function parseModelRef(value: string): ModelRef | undefined {
  const separator = value.indexOf("::");
  if (separator <= 0 || separator === value.length - 2) return undefined;
  return { provider: value.slice(0, separator), id: value.slice(separator + 2) };
}

export function modelRefValue(ref: ModelRef): string {
  return `${ref.provider}::${ref.id}`;
}

