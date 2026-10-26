/** Tiny class-name joiner — keeps badge/row markup readable without another dependency. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
