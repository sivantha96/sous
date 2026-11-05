/** Credential shapes that must never reach GitHub. Shared by the voice lint (refuse) and publishing (redact). */
export const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'GitHub token'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AWS access key'],
  [/\bsk-(ant-|proj-|or-)?[A-Za-z0-9_-]{20,}\b/g, 'API key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, 'Slack token'],
  [/\bdp\.(st|ct|pt|sa|scim)\.[A-Za-z0-9_.-]{20,}\b/g, 'Doppler token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'JWT'],
];

export const findSecrets = (text: string): string[] => SECRET_PATTERNS.filter(([re]) => new RegExp(re.source).test(text)).map(([, what]) => what);

/**
 * Makes model text safe to publish: redacts credential shapes, turns images into links
 * (no tracking pixels or remote loads), and puts @mentions in code so nobody gets notified.
 * Code spans and fences are left as they are, except for redaction.
 */
export function cleanForPublishing(text: string): string {
  let out = text;
  for (const [re] of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_, alt: string, url: string) => `[image: ${alt || 'link'}](${url})`).replace(/(^|[^\w`/.-])@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9._-]+)?)\b/g, '$1`@$2`'),
    )
    .join('');
}
