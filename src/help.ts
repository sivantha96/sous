/** A command's doc comment and usage lines, read from cli.ts's source, so asking never runs the command. */
export function helpFor(source: string, cmd: string): string | null {
  const name = cmd.replace(/[^\w-]/g, '');
  if (!name) return null;
  const def = new RegExp(`(?:/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*)?async (?:${name}|'${name}')\\(`).exec(source);
  if (!def) return null;
  const doc = (def[1] ?? '').split('\n').map((l) => l.replace(/^\s*\* ?/, '').trim()).filter(Boolean).join(' ');
  const usage = new Set(source.match(new RegExp(`usage: sous ${name}(?![\\w-])[^'\`\\n]*`, 'g')) ?? []);
  return [doc, ...usage].filter(Boolean).join('\n') || `sous ${name}`;
}
