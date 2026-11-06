/**
 * Decides, from the changed paths alone, how deep a review goes: which lenses run, whether the
 * "what was missed" pass runs, and the risk drivers behind it. Plain rules, no model call.
 */
export interface PlanFile {
  filename: string;
  additions: number;
  deletions: number;
}

export interface Plan {
  risk: number;
  drivers: string[];
  lenses: string[];
  missedPass: boolean;
  /** The PR description says how the change was tested: steps, commands, screenshots or a testing section. */
  testingNotes: boolean;
  /** Files ordered most important first, for large PRs. */
  order: string[];
}

/** Matched on whole path segments, never substrings: `token` must not match `tokenizer`. */
const TRIGGERS: { name: string; segments: RegExp; lenses: string[]; weight: number }[] = [
  { name: 'database or migrations', segments: /^(migrations?|db|sql|schema|drizzle|prisma)$/, lenses: ['specs-and-safety', 'security'], weight: 25 },
  { name: 'auth, tenancy or money', segments: /^(auth|authn|authz|session|sessions|tenant|tenants|tenancy|payments?|billing|money|stripe|wallet|rbac|permissions?)$/, lenses: ['security', 'specs-and-safety'], weight: 25 },
  { name: 'infrastructure or CI', segments: /^(infra|pulumi|terraform|\.github|workflows|policy|iam)$/, lenses: ['org-rules', 'security'], weight: 20 },
  { name: 'public contracts', segments: /^(contracts?|openapi|api|routes|events|webhooks?|proto|graphql)$/, lenses: ['contracts', 'specs-and-safety'], weight: 15 },
  { name: 'runtime start-up', segments: /^(instrument|telemetry|tracing|otel|sentry|bootstrap|main|server|worker|workers|queue|queues)(\.[a-z]+)?$/, lenses: ['specs-and-safety', 'correctness'], weight: 10 },
  { name: 'docs and decisions', segments: /^(docs|decisions|adr|runbooks?)$/, lenses: ['docs-and-decisions'], weight: 5 },
  { name: 'app UI', segments: /^(apps|components|screens|ui)$/, lenses: ['org-rules'], weight: 5 },
  { name: 'dependencies', segments: /^(package\.json|pnpm-workspace\.yaml|Dockerfile|pyproject\.toml|Cargo\.toml|go\.mod)$/, lenses: ['specs-and-safety', 'pr-hygiene'], weight: 10 },
];

const isTest = (p: string): boolean => /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.(go|py)$/.test(p);

/** Lenses every review runs, whatever the paths. */
const ALWAYS = ['correctness', 'tests-and-guards', 'pr-hygiene', 'docs-and-decisions'];

/** A testing heading, a checked test box, a command block, or an image or video in the PR description. */
export const hasTestingNotes = (body: string): boolean =>
  /^#{1,6}\s*(how (was this|to|i) test\w*|test(ing|ed|s)?|verification|verified|qa)\b/im.test(body) ||
  /^\s*[-*]\s*\[x\].*\b(test|verif|tried|ran)/im.test(body) ||
  /```[\s\S]*?\b(test|curl|pnpm|npm|yarn|pytest|go test)\b[\s\S]*?```/i.test(body) ||
  /!\[[^\]]*\]\(|<img\s|<video\s|\.(png|jpe?g|gif|mp4|mov)\b/i.test(body);

export function plan(files: PlanFile[], opts: { stacked: boolean; orgRules: boolean; body?: string }): Plan {
  const drivers = new Set<string>();
  const lenses = new Set(ALWAYS);
  let risk = 0;
  const weightOf = new Map<string, number>();
  for (const f of files) {
    const segments = f.filename.split('/');
    let w = 0;
    for (const t of TRIGGERS) {
      if (segments.some((s) => t.segments.test(s))) {
        if (!drivers.has(t.name)) risk += t.weight;
        drivers.add(t.name);
        for (const l of t.lenses) lenses.add(l);
        w += t.weight;
      }
    }
    // Code before its tests, then by risk weight, then by size.
    weightOf.set(f.filename, (isTest(f.filename) ? 0 : 1_000_000) + w * 1000 + Math.min(999, f.additions + f.deletions));
  }
  const changed = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const sizeRisk = Math.min(30, Math.round(changed / 50));
  if (sizeRisk >= 10) drivers.add(`${changed} changed lines`);
  risk = Math.min(100, risk + sizeRisk);
  const untested = files.some((f) => !isTest(f.filename) && f.additions > 20) && !files.some((f) => isTest(f.filename));
  if (untested) {
    risk = Math.min(100, risk + 10);
    drivers.add('new code without test changes');
  }
  if (opts.stacked) lenses.add('stack-consistency');
  if (opts.orgRules) lenses.add('org-rules');
  if (risk < 15) {
    // Small, low-risk PRs get the core lenses only.
    for (const l of [...lenses]) {
      if (!ALWAYS.includes(l) && l !== 'org-rules' && l !== 'stack-consistency') lenses.delete(l);
    }
  } else {
    lenses.add('specs-and-safety');
    // Every PR past the core tier also gets an attacker: a lens that tries to break the change.
    lenses.add('breaker');
  }
  // Only code changes need testing notes; a docs or test-only PR doesn't.
  const changesCode = files.some((f) => !isTest(f.filename) && !/\.(md|mdx|txt)$/i.test(f.filename));
  const testingNotes = !changesCode || hasTestingNotes(opts.body ?? '');
  if (!testingNotes) drivers.add('no testing notes in the PR description');
  return {
    risk,
    drivers: [...drivers],
    lenses: [...lenses],
    missedPass: risk >= 40,
    testingNotes,
    order: [...files].sort((a, b) => (weightOf.get(b.filename) ?? 0) - (weightOf.get(a.filename) ?? 0)).map((f) => f.filename),
  };
}

/** GitHub blob or tree links to code, pinned later to a commit. */
export interface CodeLink {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  lines?: [number, number];
}

export function codeLinks(text: string): CodeLink[] {
  const out: CodeLink[] = [];
  const re = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:blob|tree)\/([\w./-]+?)\/([^\s)#?]+)(?:#L(\d+)(?:-L(\d+))?)?/g;
  for (const m of text.matchAll(re)) {
    const lines: [number, number] | undefined = m[5] ? [Number(m[5]), Number(m[6] ?? m[5])] : undefined;
    out.push({ owner: m[1]!, repo: m[2]!, ref: m[3]!, path: m[4]!, ...(lines ? { lines } : {}) });
  }
  return out;
}
