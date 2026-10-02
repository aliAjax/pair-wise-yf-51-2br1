/**
 * 旧数据迁移：没有修订号的字幕 / 术语 / 审校规则迁移为“基准修订”(revision = 1)。
 * 迁移幂等：已带 revision 的实体不动；迁移本身登记一笔 migration 账。
 */
import type {
  Cue,
  GlossaryTerm,
  LedgerState,
  ReviewRule,
  RevisionEntry,
  TermRef
} from "./types.js";

interface LegacyCue {
  id: string;
  trackId?: string;
  locale?: string;
  start?: number;
  end?: number;
  source?: string;
  translated?: string;
  status?: Cue["status"];
  translator?: string;
  reviewerNote?: string;
  revision?: number;
  termRefs?: TermRef[];
}

interface LegacyTerm {
  id: string;
  locale?: string;
  source?: string;
  target?: string;
  status?: GlossaryTerm["status"];
  owner?: string;
  revision?: number;
}

interface LegacyRule {
  id?: string;
  locale?: string;
  title?: string;
  body?: string;
  revision?: number;
}

/** v1 localStorage 结构（旧版 stores 持久化形态）或任意缺修订号的散装数据 */
export interface LegacyShape {
  tracks?: Array<{ id: string; locale?: string }>;
  cues?: LegacyCue[];
  terms?: LegacyTerm[];
  rules?: LegacyRule[];
  reviewEvents?: unknown[];
  events?: unknown[];
  snapshots?: unknown[];
  conflicts?: unknown[];
  pendingCapacity?: number;
}

export interface MigrationReport {
  state: LedgerState;
  migratedCues: string[];
  migratedTerms: string[];
  migratedRules: string[];
  alreadyCurrent: boolean;
}

function localeOfTrack(trackId: string | undefined, tracks: LegacyShape["tracks"]) {
  const found = tracks?.find((track) => track.id === trackId);
  return found?.locale ?? trackId ?? "zh";
}

export function isLedgerState(value: unknown): value is LedgerState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schemaVersion?: number }).schemaVersion === 2 &&
    Array.isArray((value as LedgerState).ledger)
  );
}

export function migrateLegacy(raw: unknown, now: () => Date = () => new Date()): MigrationReport {
  if (isLedgerState(raw)) {
    return {
      state: raw,
      migratedCues: [],
      migratedTerms: [],
      migratedRules: [],
      alreadyCurrent: true
    };
  }

  const legacy = (raw ?? {}) as LegacyShape;
  const migratedCues: string[] = [];
  const migratedTerms: string[] = [];
  const migratedRules: string[] = [];

  const cues: Cue[] = (legacy.cues ?? []).map((cue) => {
    const locale = cue.locale ?? localeOfTrack(cue.trackId, legacy.tracks);
    if (typeof cue.revision === "number") {
      return {
        id: cue.id,
        locale,
        start: cue.start ?? 0,
        end: cue.end ?? 0,
        source: cue.source ?? "",
        translated: cue.translated ?? "",
        status: cue.status ?? "待译",
        translator: cue.translator ?? "",
        reviewerNote: cue.reviewerNote ?? "",
        revision: cue.revision,
        termRefs: cue.termRefs ?? []
      };
    }
    migratedCues.push(cue.id);
    return {
      id: cue.id,
      locale,
      start: cue.start ?? 0,
      end: cue.end ?? 0,
      source: cue.source ?? "",
      translated: cue.translated ?? "",
      status: cue.status ?? "待译",
      translator: cue.translator ?? "",
      reviewerNote: cue.reviewerNote ?? "",
      revision: 1, // 旧数据没有修订号 → 基准修订
      termRefs: []
    };
  });

  const terms: GlossaryTerm[] = (legacy.terms ?? []).map((term) => {
    const locale = term.locale ?? "en";
    if (typeof term.revision === "number") {
      return {
        id: term.id,
        locale,
        source: term.source ?? "",
        target: term.target ?? "",
        status: term.status ?? "建议",
        owner: term.owner ?? "",
        revision: term.revision
      };
    }
    migratedTerms.push(term.id);
    return {
      id: term.id,
      locale,
      source: term.source ?? "",
      target: term.target ?? "",
      status: term.status ?? "建议",
      owner: term.owner ?? "",
      revision: 1
    };
  });

  const seedRules: LegacyRule[] = legacy.rules ?? [
    {
      id: "r-default",
      locale: "*",
      title: "通用审校规则",
      body: "术语须与锁定术语一致；单行不超过 42 个全角字符；断句不得跨意群。"
    }
  ];
  const rules: ReviewRule[] = seedRules.map((rule, index) => {
    const id = rule.id ?? `r${index + 1}`;
    if (typeof rule.revision === "number") {
      return {
        id,
        locale: rule.locale ?? "*",
        title: rule.title ?? rule.body?.slice(0, 12) ?? "审校规则",
        body: rule.body ?? "",
        revision: rule.revision
      };
    }
    migratedRules.push(id);
    return {
      id,
      locale: rule.locale ?? "*",
      title: rule.title ?? rule.body?.slice(0, 12) ?? "审校规则",
      body: rule.body ?? "",
      revision: 1
    };
  });

  const total =
    migratedCues.length + migratedTerms.length + migratedRules.length;
  const entries: RevisionEntry[] = [];
  if (total > 0) {
    entries.push({
      seq: 1,
      id: typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `rev-migration-${Date.now()}`,
      time: now().toISOString(),
      entityKind: "migration",
      entityId: "schema-v1-to-v2",
      locale: "*",
      action: "迁移为基准修订",
      deviceId: "system",
      baseRevision: 0,
      newRevision: 1,
      fields: [
        { field: "migration", before: null, after: { cues: migratedCues.length, terms: migratedTerms.length, rules: migratedRules.length } }
      ]
    });
  }

  return {
    alreadyCurrent: false,
    migratedCues,
    migratedTerms,
    migratedRules,
    state: {
      schemaVersion: 2,
      cues,
      terms,
      rules,
      snapshots: [], // 旧快照不含术语/规则冻结，不并入新账本
      blockers: [],
      ledger: entries,
      nextSeq: entries.length + 1,
      pendingCapacity: legacy.pendingCapacity ?? 5
    }
  };
}
