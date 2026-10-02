import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
}

export interface Cue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  reviewerNote: string;
  /** 修订号：每次改动递增，旧数据迁移为基准修订 1 */
  rev: number;
  /** 最后改动设备 */
  deviceId?: string;
  /** 术语变更导致作废，需重进审校 */
  stale?: boolean;
  /** 引起作废的术语 id */
  invalidByTerm?: string;
  /** 先到者占住的设备/译员 */
  claimedBy?: string;
  claimedAt?: string;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
  rev: number;
  deviceId?: string;
}

export interface ReviewRules {
  requireLockedTerms: boolean;
  maxLineLength: number;
  frozen: boolean;
  frozenAt?: string;
  snapshotId?: string;
}

/** 修订账：每笔改动登记设备、基础版本、字段 */
export interface Revision {
  id: string;
  /** 全局修订号 */
  rev: number;
  deviceId: string;
  entityType: "cue" | "term" | "rules";
  entityId: string;
  /** 基础版本：本次改动所基于的修订号 */
  baseRev: number;
  field: string;
  before: unknown;
  after: unknown;
  time: string;
  actor: string;
}

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: "提交审校" | "审校通过" | "退回修改" | "术语锁定" | "术语失效" | "冲突" | "冻结" | "导出";
  detail: string;
  actor: string;
  time: string;
}

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  cues: Cue[];
  terms: GlossaryTerm[];
  rules: ReviewRules;
  frozen: boolean;
}

export interface TimelineConflict {
  id: string;
  cueId: string;
  kind: "并发提交" | "时间码冲突" | "术语失效";
  message: string;
  baseRev: number;
  latestRev: number;
  /** 最新阻塞项：后到者看到的占住/阻塞来源 */
  blockingItem: string;
  deviceId: string;
  remoteStart: number;
  remoteEnd: number;
  status: "待处理" | "采用本地" | "采用协作版本";
}

export interface ExportJob {
  locale: string;
  status: "待导出" | "已完成" | "导出失败";
  reason: string;
  updatedAt: string;
}

const KEY_V1 = "pair-wise-yf-51/subtitles-v1";
const KEY = "pair-wise-yf-51/subtitles-v2";
const KEY_REV = "pair-wise-yf-51/rev";
const KEY_DEVICE = "pair-wise-yf-51/device";
/** 待决（冲突 + 作废条目）容量上限：达到后整批发布被拒绝 */
export const MAX_PENDING = 5;

const now = () => new Date().toISOString();

function getDeviceId(): string {
  if (!browser) return "device-server";
  let id = localStorage.getItem(KEY_DEVICE);
  if (!id) {
    id = `device-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(KEY_DEVICE, id);
  }
  return id;
}
export const deviceId = getDeviceId();

let revCounter = 0;
function nextRev(): number {
  revCounter += 1;
  if (browser) localStorage.setItem(KEY_REV, String(revCounter));
  return revCounter;
}

const defaultRules: ReviewRules = { requireLockedTerms: true, maxLineLength: 42, frozen: false };

const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中" },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "", rev: 1 },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "", rev: 1 },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "", rev: 1 },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "", rev: 1 }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员", rev: 1 },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员", rev: 1 },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚", rev: 1 }
];

interface PersistShape {
  tracks?: Track[];
  cues?: Cue[];
  terms?: GlossaryTerm[];
  events?: ReviewEvent[];
  snapshots?: Snapshot[];
  revisions?: Revision[];
  rules?: ReviewRules;
  conflicts?: TimelineConflict[];
  exportJobs?: ExportJob[];
}

/** 迁移：旧数据没有修订号时迁移为基准修订 rev 1，并补建设备号 */
function migrateCues(list: Cue[] | undefined): Cue[] {
  return (list ?? seedCues).map((c) => ({ ...c, rev: typeof c.rev === "number" ? c.rev : 1, deviceId: c.deviceId ?? deviceId }));
}
function migrateTerms(list: GlossaryTerm[] | undefined): GlossaryTerm[] {
  return (list ?? seedTerms).map((t) => ({ ...t, rev: typeof t.rev === "number" ? t.rev : 1, deviceId: t.deviceId ?? deviceId }));
}

function loadState(): {
  tracks: Track[];
  cues: Cue[];
  terms: GlossaryTerm[];
  events: ReviewEvent[];
  snapshots: Snapshot[];
  revisions: Revision[];
  rules: ReviewRules;
  conflicts: TimelineConflict[];
  exportJobs: ExportJob[];
} {
  const fallback = { tracks: seedTracks, cues: seedCues, terms: seedTerms, events: [], snapshots: [], revisions: [], rules: defaultRules, conflicts: [], exportJobs: [] };
  if (!browser) return fallback;
  const rawV2 = localStorage.getItem(KEY);
  const rawV1 = localStorage.getItem(KEY_V1);
  const raw = rawV2 ?? rawV1;
  if (!raw) return fallback;
  const data: PersistShape = JSON.parse(raw);
  const cues = migrateCues(data.cues);
  const terms = migrateTerms(data.terms);
  const hadRev = (data.cues ?? []).some((c) => typeof c.rev === "number");
  let revisions = data.revisions ?? [];
  // 旧数据（v1 或无修订号）迁移为基准修订
  if (!hadRev) {
    const base: Revision[] = [
      ...cues.map((c) => ({ id: crypto.randomUUID(), rev: 1, deviceId, entityType: "cue" as const, entityId: c.id, baseRev: 0, field: "基准修订", before: null, after: null, time: now(), actor: "系统迁移" })),
      ...terms.map((t) => ({ id: crypto.randomUUID(), rev: 1, deviceId, entityType: "term" as const, entityId: t.id, baseRev: 0, field: "基准修订", before: null, after: null, time: now(), actor: "系统迁移" }))
    ];
    revisions = [...base, ...revisions];
  }
  const maxRev = Math.max(0, ...cues.map((c) => c.rev), ...terms.map((t) => t.rev), ...revisions.map((r) => r.rev));
  revCounter = maxRev;
  localStorage.setItem(KEY_REV, String(revCounter));
  return {
    tracks: data.tracks ?? seedTracks,
    cues,
    terms,
    events: data.events ?? [],
    snapshots: data.snapshots ?? [],
    revisions,
    rules: data.rules ?? defaultRules,
    conflicts: data.conflicts ?? [],
    exportJobs: data.exportJobs ?? []
  };
}

const state = loadState();

export const tracks = writable<Track[]>(state.tracks);
export const cues = writable<Cue[]>(state.cues);
export const terms = writable<GlossaryTerm[]>(state.terms);
export const reviewEvents = writable<ReviewEvent[]>(state.events);
export const snapshots = writable<Snapshot[]>(state.snapshots);
export const conflicts = writable<TimelineConflict[]>(state.conflicts);
export const revisions = writable<Revision[]>(state.revisions);
export const reviewRules = writable<ReviewRules>(state.rules);
export const exportJobs = writable<ExportJob[]>(state.exportJobs);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");

function persist() {
  if (!browser) return;
  localStorage.setItem(KEY, JSON.stringify({
    tracks: get(tracks), cues: get(cues), terms: get(terms), events: get(reviewEvents),
    snapshots: get(snapshots), revisions: get(revisions), rules: get(reviewRules),
    conflicts: get(conflicts), exportJobs: get(exportJobs)
  }));
}
[tracks, cues, terms, reviewEvents, snapshots, conflicts, revisions, reviewRules, exportJobs].forEach((store) => store.subscribe(persist));

function event(cue: Cue | undefined, action: ReviewEvent["action"], detail: string) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor: get(reviewer), time: now() }, ...items]);
}

/** 登记一笔修订：设备、基础版本、字段 */
function commit(
  entityType: Revision["entityType"],
  entity: { id: string },
  field: string,
  before: unknown,
  after: unknown,
  baseRev: number
): number {
  const rev = nextRev();
  const entry: Revision = {
    id: crypto.randomUUID(), rev, deviceId, entityType, entityId: entity.id,
    baseRev, field, before, after, time: now(), actor: get(reviewer)
  };
  revisions.update((r) => [entry, ...r].slice(0, 300));
  return rev;
}

function fieldLabel(field: string): string {
  const map: Record<string, string> = { source: "原文", translated: "译文", start: "开始秒", end: "结束秒", status: "状态", target: "译法", "提交审校": "提交审校", "术语失效": "术语失效", 拆分: "拆分", 合并: "合并" };
  return map[field] ?? field;
}

export interface OpResult {
  ok: boolean;
  blocked?: boolean;
  conflict?: boolean;
  reason?: string;
}

/** 冻结期间不得覆盖已通过结论 */
function frozenBlocks(cue: Cue): boolean {
  return get(reviewRules).frozen && cue.status === "已通过";
}

/** 登记一条冲突：后到者看到冲突与最新阻塞项 */
function raiseConflict(cue: Cue, kind: TimelineConflict["kind"], baseRev: number, blockingItem: string) {
  const entry: TimelineConflict = {
    id: crypto.randomUUID(),
    cueId: cue.id,
    kind,
    message:
      kind === "并发提交"
        ? `两名译员同时提交同一字幕，先到者已占住，后到提交被拒绝。`
        : kind === "术语失效"
          ? `术语译法变更导致引用该术语的字幕作废，需重新审校。`
          : `协作方调整了时间码，与本机版本不一致。`,
    baseRev,
    latestRev: cue.rev,
    blockingItem,
    deviceId,
    remoteStart: cue.start,
    remoteEnd: cue.end,
    status: "待处理"
  };
  conflicts.update((items) => [entry, ...items]);
  event(cue, "冲突", `${kind}：${blockingItem}（基础修订 ${baseRev} → 最新 ${cue.rev}）`);
}

/** 编辑字幕；baseRev 为译者看到的基础版本，不一致则触发并发冲突 */
export function updateCue(id: string, patch: Partial<Cue>, baseRev?: number): OpResult {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return { ok: false, reason: "字幕不存在" };
  if (frozenBlocks(cue)) {
    event(cue, "冲突", `冻结期间不可覆盖已通过结论（${fieldLabel(Object.keys(patch)[0] ?? "内容")}）`);
    return { ok: false, blocked: true, reason: "冻结期间不可覆盖已通过结论" };
  }
  if (baseRev !== undefined && baseRev !== cue.rev) {
    raiseConflict(cue, "并发提交", baseRev, cue.claimedBy ? `${cue.claimedBy} 已占住并提交` : `最新修订 ${cue.rev}`);
    return { ok: false, conflict: true, reason: "基础版本已过期" };
  }
  const field = Object.keys(patch)[0] ?? "translated";
  const rev = commit("cue", cue, field, (cue as Record<string, unknown>)[field], (patch as Record<string, unknown>)[field], cue.rev);
  cues.update((items) =>
    items.map((item) =>
      item.id === id
        ? {
            ...item,
            ...patch,
            rev,
            deviceId,
            // 译者重新触碰译文即处理作废标记，待提交时正式重进审校
            stale: patch.translated !== undefined ? false : item.stale,
            invalidByTerm: patch.translated !== undefined ? undefined : item.invalidByTerm
          }
        : item
    )
  );
  return { ok: true };
}

export function nudgeCue(id: string, delta: number) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  if (frozenBlocks(cue)) return;
  const start = Math.max(0, Number((cue.start + delta).toFixed(1)));
  const end = Math.max(start + 0.5, Number((cue.end + delta).toFixed(1)));
  const rev = commit("cue", cue, "start", { start: cue.start, end: cue.end }, { start, end }, cue.rev);
  cues.update((items) => items.map((item) => (item.id === id ? { ...item, start, end, rev, deviceId } : item)));
}

export function splitCue(id: string) {
  const list = get(cues);
  const cue = list.find((item) => item.id === id);
  if (!cue || cue.end - cue.start < 1) return;
  if (frozenBlocks(cue)) return;
  const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
  const rev1 = commit("cue", cue, "拆分", { end: cue.end }, { end: middle }, cue.rev);
  const first: Cue = { ...cue, end: middle, status: "翻译中", rev: rev1, deviceId, stale: false, invalidByTerm: undefined };
  const secondId = crypto.randomUUID();
  const rev2 = nextRev();
  const second: Cue = { ...cue, id: secondId, start: middle, translated: "", status: "待译", rev: rev2, deviceId, claimedBy: undefined, claimedAt: undefined, stale: false, invalidByTerm: undefined };
  revisions.update((r) => [{ id: crypto.randomUUID(), rev: rev2, deviceId, entityType: "cue", entityId: secondId, baseRev: 0, field: "拆分新建", before: null, after: null, time: now(), actor: get(reviewer) }, ...r].slice(0, 300));
  cues.set(list.flatMap((item) => (item.id === id ? [first, second] : [item])));
  selectedCueId.set(secondId);
}

export function mergeNext(id: string) {
  const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return;
  if (frozenBlocks(current)) return;
  const rev = commit("cue", current, "合并", { end: current.end, translated: current.translated }, { end: next.end, translated: `${current.translated} ${next.translated}`.trim() }, current.rev);
  cues.update((items) =>
    items
      .filter((item) => item.id !== next.id)
      .map((item) => (item.id === id ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中", rev, deviceId } : item))
  );
}

export function setCueStatus(id: string, status: CueStatus) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  if (frozenBlocks(cue)) return;
  const rev = commit("cue", cue, "status", cue.status, status, cue.rev);
  cues.update((items) => items.map((item) => (item.id === id ? { ...item, status, rev, deviceId } : item)));
  event(cue, status === "待审" ? "提交审校" : status === "已通过" ? "审校通过" : "退回修改", cue.translated);
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  if (frozenBlocks(cue)) {
    event(cue, "冲突", "冻结期间不可覆盖已通过结论");
    return;
  }
  const status = approved ? "已通过" : "退回";
  const rev = commit("cue", cue, "status", cue.status, status, cue.rev);
  cues.update((items) => items.map((item) => (item.id === id ? { ...item, status, reviewerNote: note, rev, deviceId, stale: false, invalidByTerm: undefined } : item)));
  event(cue, approved ? "审校通过" : "退回修改", note || cue.translated);
}

/** 提交审校：先到者占住；基础版本过期则后到者见冲突与最新阻塞项 */
export function submitCue(id: string, baseRev?: number): OpResult {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return { ok: false, reason: "字幕不存在" };
  if (frozenBlocks(cue)) return { ok: false, blocked: true, reason: "冻结期间不可覆盖已通过结论" };
  if (baseRev !== undefined && baseRev !== cue.rev) {
    raiseConflict(cue, "并发提交", baseRev, cue.claimedBy ? `${cue.claimedBy} 已占住并提交（修订 ${cue.rev}）` : `最新修订 ${cue.rev}`);
    return { ok: false, conflict: true, reason: "基础版本已过期" };
  }
  const rev = commit("cue", cue, "提交审校", cue.status, "待审", cue.rev);
  cues.update((items) =>
    items.map((item) =>
      item.id === id
        ? { ...item, status: "待审", rev, deviceId, claimedBy: deviceId, claimedAt: now(), stale: false, invalidByTerm: undefined, reviewerNote: "" }
        : item
    )
  );
  event(cue, "提交审校", `先到占住 · 修订 ${rev}`);
  return { ok: true };
}

/** 模拟另一名译员抢先提交同一字幕（占住），用于演示并发冲突 */
export function simulateCollaborator(id: string) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  const other = `device-协作-${crypto.randomUUID().slice(0, 4)}`;
  const rev = commit("cue", cue, "协作提交", cue.status, "待审", cue.rev);
  cues.update((items) => items.map((item) => (item.id === id ? { ...item, status: "待审", rev, deviceId: other, claimedBy: other, claimedAt: now() } : item)));
  event(cue, "提交审校", `协作者抢先提交并占住（修订 ${rev}）`);
}

export function lockTerm(id: string) {
  const term = get(terms).find((item) => item.id === id);
  if (!term) return;
  const rev = commit("term", term, "status", term.status, "已锁定", term.rev);
  terms.update((items) => items.map((item) => (item.id === id ? { ...item, status: "已锁定", owner: "术语管理员", rev, deviceId } : item)));
  const cue = get(cues).find((item) => item.id === get(selectedCueId));
  event(cue, "术语锁定", `${term.source} → ${term.target}`);
}

/** 修改术语译法：引用该术语的待审字幕立即失效重进审校，并写明由哪条术语引起 */
export function updateTermTarget(id: string, newTarget: string): OpResult {
  const term = get(terms).find((item) => item.id === id);
  if (!term) return { ok: false, reason: "术语不存在" };
  if (get(reviewRules).frozen) {
    event(undefined, "冲突", "冻结期间不可修改术语译法");
    return { ok: false, blocked: true, reason: "冻结期间不可修改术语" };
  }
  const next = newTarget.trim();
  if (!next || next === term.target) return { ok: false, reason: "译法未变化" };
  const old = term.target;
  const rev = commit("term", term, "target", old, next, term.rev);
  terms.update((items) => items.map((item) => (item.id === id ? { ...item, target: next, rev, deviceId } : item)));

  // 引用该术语（译文含旧译法或原文含源词）的待审字幕立即失效
  const affected = get(cues).filter(
    (c) => c.status === "待审" && (c.translated.includes(old) || c.source.includes(term.source))
  );
  const revs = new Map<string, number>();
  for (const c of affected) {
    const crev = commit("cue", c, "术语失效", c.status, "待审", c.rev);
    revs.set(c.id, crev);
    event(c, "术语失效", `术语「${term.source}」译法 ${old} → ${next}，引用该术语的字幕作废，重进审校（修订 ${crev}）`);
  }
  cues.update((items) =>
    items.map((c) =>
      revs.has(c.id) ? { ...c, stale: true, invalidByTerm: term.id, rev: revs.get(c.id)! } : c
    )
  );
  if (affected.length) {
    const cue0 = affected[0];
    conflicts.update((items) => [
      {
        id: crypto.randomUUID(),
        cueId: cue0.id,
        kind: "术语失效",
        message: `术语「${term.source}」译法 ${old} → ${next}，${affected.length} 条引用字幕作废重审。`,
        baseRev: term.rev,
        latestRev: rev,
        blockingItem: `阻塞项：术语 ${term.source} 的译法已变更为 ${next}`,
        deviceId,
        remoteStart: cue0.start,
        remoteEnd: cue0.end,
        status: "待处理"
      },
      ...items
    ]);
  }
  return { ok: true };
}

/** 待决容量：待处理冲突 + 作废字幕 */
export function pendingCount(): number {
  const pendingConflicts = get(conflicts).filter((c) => c.status === "待处理").length;
  const staleCues = get(cues).filter((c) => c.stale).length;
  return pendingConflicts + staleCues;
}

/** 整批发布：待决条目累计到容量上限则整批拒绝，草稿保留不丢 */
export function publishBatch(): OpResult & { draftsKept?: number; pending?: number } {
  const pending = pendingCount();
  const drafts = get(cues).filter((c) => c.status === "翻译中" || c.status === "待译");
  if (pending >= MAX_PENDING) {
    event(undefined, "冲突", `待决条目 ${pending} 达到容量上限 ${MAX_PENDING}，整批发布被拒绝，${drafts.length} 条草稿保留不丢失。`);
    return { ok: false, reason: "待决容量超限，整批发布拒绝", pending, draftsKept: drafts.length };
  }
  let submitted = 0;
  for (const draft of drafts) {
    if (draft.stale) continue; // 作废字幕不发布，计入待决
    const result = submitCue(draft.id);
    if (result.ok) submitted += 1;
  }
  event(undefined, "导出", `整批发布：${submitted} 条草稿提交审校，待决 ${pending} / ${MAX_PENDING}`);
  return { ok: true, pending, draftsKept: drafts.length };
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]) {
  conflicts.update((items) => items.map((item) => (item.id === id ? { ...item, status: resolution } : item)));
  const conflict = get(conflicts).find((item) => item.id === id);
  if (resolution === "采用协作版本" && conflict) {
    const rev = commit("cue", { id: conflict.cueId }, "时间码冲突", { start: conflict.remoteStart, end: conflict.remoteEnd }, "采用协作版本", conflict.latestRev);
    cues.update((items) => items.map((item) => (item.id === conflict.cueId ? { ...item, start: conflict.remoteStart, end: conflict.remoteEnd, rev, deviceId } : item)));
  }
  if (resolution !== "待处理") event(undefined, "冲突", `冲突已${resolution}：${conflict?.message ?? ""}`);
}

/** 快照冻结当时各语言字幕、术语与审校规则 */
export function createSnapshot(name = `时间轴快照 ${get(snapshots).length + 1}`) {
  const snap: Snapshot = {
    id: crypto.randomUUID(),
    name,
    time: now(),
    cues: structuredClone(get(cues)),
    terms: structuredClone(get(terms)),
    rules: structuredClone(get(reviewRules)),
    frozen: true
  };
  snapshots.update((items) => [snap, ...items].slice(0, 12));
  reviewRules.update((r) => ({ ...r, frozen: true, frozenAt: snap.time, snapshotId: snap.id }));
  event(undefined, "冻结", `快照「${name}」冻结 ${snap.cues.length} 条字幕、${snap.terms.length} 条术语与审校规则`);
}

export function restoreSnapshot(id: string) {
  const snap = get(snapshots).find((item) => item.id === id);
  if (!snap) return;
  cues.set(structuredClone(snap.cues));
  terms.set(structuredClone(snap.terms));
  reviewRules.set({ ...structuredClone(snap.rules), frozen: true, frozenAt: snap.time, snapshotId: snap.id });
  event(undefined, "冻结", `已恢复快照「${snap.name}」，冻结状态保持`);
}

export function unfreeze() {
  reviewRules.update((r) => ({ ...r, frozen: false, frozenAt: undefined, snapshotId: undefined }));
  event(undefined, "冻结", "已解除冻结，可继续编辑");
}

function exportBlockers(locale: string): string {
  const langCues = get(cues).filter((c) => c.trackId === locale);
  const pending = langCues.filter((c) => c.status === "待审" || c.status === "翻译中" || c.status === "待译");
  const stale = langCues.filter((c) => c.stale);
  const conf = get(conflicts).filter((c) => c.status === "待处理" && langCues.some((lc) => lc.id === c.cueId));
  const reasons: string[] = [];
  if (pending.length) reasons.push(`${pending.length} 条字幕未通过审校`);
  if (stale.length) reasons.push(`${stale.length} 条字幕因术语失效待重审`);
  if (conf.length) reasons.push(`${conf.length} 条冲突未解决`);
  return reasons.join("；");
}

/** 导出：逐语言进行，已完成语言保留，失败语言标记后只补未完成 */
function processExport(): { done: number; failed: number } {
  const jobs = get(exportJobs);
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    if (job.status === "已完成") { done += 1; continue; } // 保留已完成语言，不重复导出
    const reason = exportBlockers(job.locale);
    if (reason) {
      failed += 1;
      exportJobs.update((list) => list.map((x) => (x.locale === job.locale ? { ...x, status: "导出失败", reason, updatedAt: now() } : x)));
    } else {
      done += 1;
      exportJobs.update((list) => list.map((x) => (x.locale === job.locale ? { ...x, status: "已完成", reason: "", updatedAt: now() } : x)));
    }
  }
  event(undefined, "导出", `导出完成 ${done} 种语言，失败 ${failed} 种；已完成语言保留，仅补未完成语言。`);
  return { done, failed };
}

export function runExport() {
  const jobs: ExportJob[] = get(tracks).map((t) => ({ locale: t.locale, status: "待导出", reason: "", updatedAt: now() }));
  exportJobs.set(jobs);
  return processExport();
}

/** 补导出：只处理未完成（待导出 / 导出失败）语言 */
export function retryExport() {
  return processExport();
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) =>
  $cues
    .filter((cue) => cue.trackId === $activeTrackId)
    .sort((a, b) => a.start - b.start)
    .map((cue) => ({ ...cue, selected: cue.id === $selectedCueId }))
);
