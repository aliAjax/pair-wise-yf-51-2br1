/**
 * 可恢复修订账 —— 类型定义
 *
 * 每一笔改动（RevisionEntry）都登记：设备、基础版本(baseRevision)、字段。
 * 字幕 / 术语 / 审校规则都带 revision；旧数据迁移为基准修订 1。
 */

export type EntityKind = "cue" | "term" | "rule";
export type FieldKey =
  | "source"
  | "translated"
  | "start"
  | "end"
  | "status"
  | "note"
  | "target"
  | "status:term"
  | "ruleBody"
  | "snapshot"
  | "deliverable"
  | "migration";

export type CueStatus =
  | "待译"
  | "翻译中"
  | "待审"
  | "已通过"
  | "退回"
  | "失效";

export interface FieldChange {
  field: FieldKey;
  before: unknown;
  after: unknown;
}

/** 一条字幕对某条术语的引用，按术语修订号钉住 */
export interface TermRef {
  termId: string;
  /** 引用时术语的修订号；术语升版后与当前 revision 不等即为“旧术语拖住” */
  termRevision: number;
}

export interface Cue {
  id: string;
  locale: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  reviewerNote: string;
  revision: number;
  termRefs: TermRef[];
  /** 术语改译导致本条失效时，写明是哪条术语引起的 */
  invalidatedBy?: {
    kind: "term";
    termId: string;
    termSource: string;
    fromRevision: number;
    toRevision: number;
  };
  /** 审校占用（先到者占住），后到者凭它看到冲突 */
  lock?: {
    deviceId: string;
    /** 占用者所基于的字幕修订号 */
    baseRevision: number;
    since: string;
  };
}

export interface GlossaryTerm {
  id: string;
  locale: string;
  source: string;
  target: string;
  status: "建议" | "已锁定";
  owner: string;
  revision: number;
}

export interface ReviewRule {
  id: string;
  locale: string;
  title: string;
  body: string;
  revision: number;
}

export interface FrozenCue {
  id: string;
  status: CueStatus;
  translated: string;
  revision: number;
  termRefs: TermRef[];
}
export interface FrozenTerm {
  id: string;
  target: string;
  status: GlossaryTerm["status"];
  revision: number;
}
export interface FrozenRule {
  id: string;
  body: string;
  revision: number;
}

export type ExportStatus = "未导出" | "已完成" | "失败";

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  /** 冻结时各语言的字幕、术语、审校规则 */
  frozen: Record<
    string,
    { cues: FrozenCue[]; terms: FrozenTerm[]; rules: FrozenRule[] }
  >;
  /** 导出交付状态：逐语言保留已完成语言，失败后只补未完成语言 */
  exportStatus: Record<string, ExportStatus>;
  exportError?: string;
}

export type BlockerKind = "submit-conflict" | "term-invalidation";

export interface Blocker {
  id: string;
  kind: BlockerKind;
  locale: string;
  cueId: string;
  message: string;
  status: "待处理" | "已解决";
  deviceId?: string;
  baseRevision?: number;
  /** 最新阻塞项快照，后到者提交时刷新看到 */
  detail: Record<string, unknown>;
  time: string;
}

export interface RevisionEntry {
  seq: number;
  id: string;
  time: string;
  entityKind: EntityKind | "snapshot" | "batch" | "migration";
  entityId: string;
  locale: string;
  action: string;
  deviceId: string;
  /** 基础版本：本笔改动基于哪个修订号 */
  baseRevision: number;
  /** 改动后修订号（快照/发布类动作为 0） */
  newRevision: number;
  fields: FieldChange[];
  /** 失效重进审校时写明触发源，例如 term:g1 */
  causedBy?: string;
  rejected?: string;
}

export interface LedgerState {
  schemaVersion: 2;
  cues: Cue[];
  terms: GlossaryTerm[];
  rules: ReviewRule[];
  snapshots: Snapshot[];
  blockers: Blocker[];
  ledger: RevisionEntry[];
  nextSeq: number;
  /** 待决容量上限：冲突 + 作废条目累计到该值，整批发布被拒绝 */
  pendingCapacity: number;
}

/** 动作结果：ok=false 时 state 原样返回，error 说明原因（草稿不动） */
export interface ActionResult {
  ok: boolean;
  state: LedgerState;
  error?: string;
  /** 本次动作联动到的字幕（如术语改译后失效的待审字幕） */
  affectedCueIds?: string[];
}
