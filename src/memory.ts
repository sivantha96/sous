/**
 * Sous's memory is plain markdown bullets in ~/.sous. One bullet is one self-contained line, so a
 * search hit makes sense on its own:
 *
 *   - [scope: services/api/**, packages/**] the rule or fact (source: core#136 comment) (cite: owner/repo:path@sha12)
 *
 * Scope, source and cite are optional. "Proof: `a`, `b`" is read as unpinned citations, for older bullets.
 */
export interface Cite {
  repo?: string;
  path: string;
  sha?: string;
}

export interface Bullet {
  file: string;
  line: number;
  scope: string[];
  text: string;
  source?: string;
  cites: Cite[];
  raw: string;
}

const CITE = /\(cite: ([^)]+)\)/;
const SOURCE = /\(source: ([^)]+)\)/;
const SCOPE = /^- \[(?:scope: )?([^\]]+)\]\s*/;

function parseCite(s: string): Cite | null {
  const m = /^(?:([\w.-]+\/[\w.-]+):)?([^@\s]+?)(?:@([0-9a-f]{7,40}))?$/.exec(s.trim().replace(/^`|`$/g, ''));
  if (!m || !/[/.]/.test(m[2]!)) return null;
  return { ...(m[1] ? { repo: m[1] } : {}), path: m[2]!, ...(m[3] ? { sha: m[3] } : {}) };
}

export function parseBullets(file: string, content: string): Bullet[] {
  return content.split('\n').flatMap((raw, i) => {
    if (!raw.startsWith('- ')) return [];
    const scope = SCOPE.exec(raw)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    const cites = [
      ...(CITE.exec(raw)?.[1]?.split(',') ?? []),
      ...(/Proof: (.+)$/.exec(raw)?.[1]?.match(/`[^`]+`/g) ?? []),
    ].flatMap((c) => parseCite(c) ?? []);
    const text = raw.replace(SCOPE, '').replace(CITE, '').replace(SOURCE, '').replace(/^- /, '').trim();
    const source = SOURCE.exec(raw)?.[1];
    return [{ file, line: i + 1, scope, text, ...(source ? { source } : {}), cites, raw }];
  });
}

const globRe = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.')}$`);

export const scopeMatches = (scope: string[], paths: string[]): boolean =>
  scope.length === 0 || scope.some((s) => s === 'all' || paths.some((p) => globRe(s).test(p) || p.startsWith(s.replace(/\*.*$/, '')) && s.endsWith('**')));

/** Names a diff touches: file basenames, exported names, env vars, endpoints, package names. */
export function diffTerms(files: { filename: string; patch?: string }[]): string[] {
  const terms = new Set<string>();
  for (const f of files) {
    const base = f.filename.split('/').pop()!.replace(/\.(test|spec)?\.?[a-z]+$/, '');
    if (base.length >= 4) terms.add(base);
    for (const row of (f.patch ?? '').split('\n')) {
      if (!/^[+-]/.test(row) || /^(\+\+\+|---)/.test(row)) continue;
      for (const m of row.matchAll(/export (?:default )?(?:async )?(?:const|let|function|class|type|interface|enum) ([A-Za-z_]\w{3,})/g)) terms.add(m[1]!);
      for (const m of row.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]{2,})\b/g)) terms.add(m[1]!);
      for (const m of row.matchAll(/['"`](\/v\d+\/[\w/{}:-]+)['"`]/g)) terms.add(m[1]!);
      for (const m of row.matchAll(/['"](@[\w-]+\/[\w.-]+)['"]/g)) terms.add(m[1]!);
    }
  }
  return [...terms].slice(0, 80);
}

export interface Hit {
  bullet: Bullet;
  score: number;
  matchedBy: string[];
}

/** Bullets for a PR: scope matches score 2, each distinct term found scores 1. Highest first. */
export function searchMemory(bullets: Bullet[], paths: string[], terms: string[], limit = 40): Hit[] {
  const hits: Hit[] = [];
  for (const b of bullets) {
    const matchedBy: string[] = [];
    let score = 0;
    if (b.scope.length && scopeMatches(b.scope, paths)) {
      score += 2;
      matchedBy.push('scope');
    }
    const lower = b.raw.toLowerCase();
    for (const t of terms) {
      if (lower.includes(t.toLowerCase())) {
        score++;
        matchedBy.push(t);
      }
    }
    if (score > 0) hits.push({ bullet: b, score, matchedBy });
  }
  return hits.sort((a, b) => b.score - a.score || a.bullet.file.localeCompare(b.bullet.file) || a.bullet.line - b.bullet.line).slice(0, limit);
}

export type FactState = 'current' | 'stale' | 'gone' | 'unpinned';

/**
 * Where a cited fact stands: `gone` when its file no longer exists, `stale` when the file changed
 * after the pinned commit, `unpinned` when no commit was recorded.
 */
export function factState(cite: Cite, latest: string | null | 'deleted'): FactState {
  if (latest === 'deleted') return 'gone';
  if (!cite.sha) return 'unpinned';
  return latest && !latest.startsWith(cite.sha) ? 'stale' : 'current';
}

/** Rewrites a bullet's cites with pinned commits, in the canonical form. */
export function pinBullet(raw: string, pins: Cite[]): string {
  const cite = `(cite: ${pins.map((c) => `${c.repo ? `${c.repo}:` : ''}${c.path}${c.sha ? `@${c.sha.slice(0, 12)}` : ''}`).join(', ')})`;
  return CITE.test(raw) ? raw.replace(CITE, cite) : `${raw.replace(/\s*Proof: .+$/, '')} ${cite}`;
}
