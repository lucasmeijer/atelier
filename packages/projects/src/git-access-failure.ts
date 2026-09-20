/** A rejected SSH public-key authentication, not a general repository access failure. */
export function isSshAuthenticationFailure(diagnostic: string): boolean {
  return /permission denied \([^\r\n)]*\bpublickey\b[^\r\n)]*\)/i.test(diagnostic);
}
