import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeHome } from './home.ts';

/**
 * Token use per subagent, read from Claude Code's own transcripts: Sous runs on a subscription, so
 * there's no API bill to read. Each subagent writes `subagents/agent-<id>.jsonl` (one usage block per
 * model reply) beside `agent-<id>.meta.json` (its type and description).
 */
/** Where Claude Code keeps the session transcripts of one folder. */
export function projectsDir(cwd: string, root = claudeHome()): string {
  return join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
}

const empty = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });

export function addUsage(u: Usage, block: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): void {
  u.input += block.input_tokens ?? 0;
  u.output += block.output_tokens ?? 0;
  u.cacheRead += block.cache_read_input_tokens ?? 0;
  u.cacheWrite += block.cache_creation_input_tokens ?? 0;
  u.calls++;
}

/** Sums one transcript's replies by model. Duplicate reply ids (streamed parts) count once. */
export function usageByModel(jsonl: string): Record<string, Usage> {
  const out: Record<string, Usage> = {};
  const seen = new Set<string>();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let d: { message?: { id?: string; model?: string; usage?: Parameters<typeof addUsage>[1] } };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const m = d.message;
    if (!m?.usage || !m.model) continue;
    if (m.id) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
    }
    addUsage((out[m.model] ??= empty()), m.usage);
  }
  return out;
}

export function mergeUsage(into: Record<string, Usage>, from: Record<string, Usage>): Record<string, Usage> {
  for (const [k, v] of Object.entries(from)) {
    const t = (into[k] ??= empty());
    t.input += v.input;
    t.output += v.output;
    t.cacheRead += v.cacheRead;
    t.cacheWrite += v.cacheWrite;
    t.calls += v.calls;
  }
  return into;
}

/** Subagent transcripts in a session's `subagents/` folder, including those a Workflow ran under `workflows/<run>/`. */
export function subagentLogs(subDir: string): string[] {
  if (!existsSync(subDir)) return [];
  const runs = existsSync(join(subDir, 'workflows')) ? readdirSync(join(subDir, 'workflows')).map((r) => join(subDir, 'workflows', r)) : [];
  return [subDir, ...runs].flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => join(d, f)));
}

/** Seconds from a transcript's first to last timestamped line: how long that agent ran. */
export function spanSeconds(jsonl: string): number {
  let first = Infinity;
  let last = -Infinity;
  for (const line of jsonl.split('\n')) {
    let t: number;
    try {
      t = Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? '');
    } catch {
      continue;
    }
    if (Number.isNaN(t)) continue;
    first = Math.min(first, t);
    last = Math.max(last, t);
  }
  return last > first ? Math.round((last - first) / 1000) : 0;
}
