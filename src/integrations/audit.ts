// Append-only audit log for the protected boundary (src/integrations/protected.ts).
// Independent, unofficial code; not affiliated with or endorsed by Salus.
//
// - append() is the only write. Nothing is ever rewritten, reordered or deleted, in memory or on disk.
// - Stored entries are private deep copies; entries() hands out fresh copies, so callers cannot alter the log.
// - With `file`, every entry is written as one JSON line with appendFileSync BEFORE it becomes visible in memory, and
//   a new log on the same file loads the earlier lines first, so a restarted process sees the earlier history.
//
// The log correlates by `idempotency_key` (we do not have a documented Salus decision ID; docs/decide-contract.md,
// "Not documented" item 1).

import fs from "node:fs";

export type AuditEntry = Record<string, unknown> & { phase: string; idempotency_key?: string };

export interface AuditLog {
  append(entry: AuditEntry): void;
  entries(): AuditEntry[];
}

// Marker appended (never rewritten in place) after a line that a crash left half-written.
const TORN_PHASE = "torn_line_skipped";

const isObject =(v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toEntry(value: unknown): AuditEntry | undefined {
  return isObject(value) && typeof value.phase === "string" && value.phase.length > 0 ? (value as AuditEntry) : undefined;
}

export function createAuditLog(file?: string): AuditLog {
  // Serialised JSON lines are the stored form: they cannot be mutated through a reference, and each entries() call
  // parses a fresh copy.
  const lines: string[] = [];

  if (file !== undefined) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      const raw = text.split("\n");
      const endsCleanly = text.length === 0 || text.endsWith("\n");
      const parse = (line: string): AuditEntry | undefined => {
        try {
          return toEntry(JSON.parse(line));
        } catch {
          return undefined;
        }
      };
      let tornLine: number | undefined;
      for (let i = 0; i < raw.length; i += 1) {
        const line = raw[i] ?? "";
        if (line.trim() === "") continue;
        const entry = parse(line);
        if (entry) {
          lines.push(JSON.stringify(entry));
          continue;
        }
        if (i === raw.length - 1 && !endsCleanly) {
          // A torn final line (a crash in the middle of a write). It stays in the file untouched; we skip it and
          // record that below, append-only.
          tornLine = i + 1;
          continue;
        }
        // A torn line acknowledged on an earlier load is followed by its TORN_PHASE marker.
        const next = raw.slice(i + 1).find((l) => l.trim() !== "");
        const marker = next === undefined ? undefined : parse(next);
        if (marker?.phase === TORN_PHASE && marker.line === i + 1) continue;
        // Never silently drop history: any other corrupt line is an error for the operator.
        throw new Error(`audit log ${file}: line ${i + 1} is not a valid audit entry`);
      }
      if (tornLine !== undefined) {
        // Terminate the torn line, then note it, so the next entry starts on its own line and a later load knows
        // exactly which line was skipped.
        const marker = JSON.stringify({ phase: TORN_PHASE, line: tornLine });
        fs.appendFileSync(file, "\n" + marker + "\n");
        lines.push(marker);
      } else if (!endsCleanly) {
        fs.appendFileSync(file, "\n"); // a complete final entry that only lost its newline
      }
    }
  }

  return {
    append(entry) {
      const line = JSON.stringify(entry);
      const checked = toEntry(line === undefined ? undefined : JSON.parse(line));
      if (!checked) throw new TypeError("audit entry must be an object with a non-empty string `phase`");
      // Persist first: an entry that is visible in memory has always reached the file.
      if (file !== undefined) fs.appendFileSync(file, line + "\n");
      lines.push(line);
    },

    entries() {
      return lines.map((line) => JSON.parse(line) as AuditEntry);
    },
  };
}

// Idempotency keys that Salus allowed but that have no "executed" entry: the process crashed between the decision and
// the effect, or the provider call failed and the outcome is unknown (an "outcome_unknown" entry). Retrying is safe because the same key goes to
// the provider, whose idempotency replays a refund that did happen. Keys are listed in the order first allowed.
export function pendingActions(audit: Pick<AuditLog, "entries">): string[] {
  const allowed: string[] = [];
  const executed = new Set<string>();
  for (const entry of audit.entries()) {
    const key = entry.idempotency_key;
    if (typeof key !== "string") continue;
    if (entry.phase === "decided" && entry.decision === "allow" && !allowed.includes(key)) allowed.push(key);
    if (entry.phase === "executed") executed.add(key);
  }
  return allowed.filter((key) => !executed.has(key));
}
