import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";
import {
  attachTermRef,
  blockersForCue,
  cueById,
  editCue,
  exportBatch,
  freezeSnapshot,
  pendingBlockers,
  rebaseCueToTerms,
  resolveBlocker,
  reviewCue,
  submitCue,
  updateRule,
  updateTerm
} from "$lib/ledger/engine";
import type { ActionResult, Blocker, Cue, CueStatus, LedgerState, ReviewRule } from "$lib/ledger/types";
import { migrateLegacy } from "$lib/ledger/migrate";

export type { Cue, CueStatus, GlossaryTerm, ReviewRule, Snapshot, Blocker, RevisionEntry } from "$lib/ledger/types";
export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";

export interface Track {
  id: string;
  name: string;
  locale: string;
}

const KEY_V2 = "pair-wise-yf-51/ledger-v2";
const KEY_V1 = "pair-wise-yf-51/subtitles-v1";
const DEVICE_KEY = "pair-wise-yf-51/device";

export const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh" },
  { id: "en", name: "English 翻译", locale: "en" },
  { id: "ja", name: "日本語訳", locale: "ja" }
];

function legacyV1() {
  if (!browser) return null;
  const raw = localStorage.getItem(KEY_V1);
  return raw ? JSON.parse(raw) : null;
}

function initialState(): LedgerState {
  if (browser) {
    // 已是修订账结构
    const rawV2 = localStorage.getItem(KEY_V2);
    if (rawV2) {
      const parsed = JSON.parse(rawV2);
      if (parsed?.schemaVersion === 2) return parsed as LedgerState;
    }
    // 旧数据（含无修订号的散装数据）迁移为基准修订
    const v1 = legacyV1();
    if (v1) {
      const report = migrateLegacy(v1);
      return report.state;
    }
  }
  return freshState();
}

/** 全新现场：内置字幕/术语同样以基准修订 r1 起账 */
export function freshState(): LedgerState {
  const report = migrateLegacy({
    tracks: seedTracks,
    cues: [
      { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "" },
      { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "" },
      { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "" },
      { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "" }
    ],
    terms: [
      { id: "g1", locale: "en", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员" },
      { id: "g2", locale: "en", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员" },
      { id: "g3", locale: "en", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
    ]
  });
  // 让待审字幕 c2 引用术语 g1，以便演示“术语一改、待审立即失效”
  const attached = attachTermRef(report.state, { deviceId: "system-seed", cueId: "c2", termId: "g1" });
  return attached.state;
}

function defaultDevice(): string {
  if (!browser) return "device-A-林岚";
  const saved = localStorage.getItem(DEVICE_KEY);
  if (saved) return saved;
  const id = `device-${Math.random().toString(36).slice(2, 6)}-林岚`;
  localStorage.setItem(DEVICE_KEY, id);
  return id;
}

export const ledger = writable<LedgerState>(initialState());
export const tracks = writable<Track[]>(seedTracks);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const deviceId = writable<string>(defaultDevice());

/** 最近一次动作回执（成功/失败都进提示条；失败时 state 已含记账或原样） */
export interface Notice {
  id: string;
  ok: boolean;
  text: string;
}
export const notices = writable<Notice[]>([]);

function persist(state: LedgerState) {
  if (!browser) return;
  localStorage.setItem(KEY_V2, JSON.stringify(state));
}
ledger.subscribe(persist);
deviceId.subscribe((value) => browser && localStorage.setItem(DEVICE_KEY, value));

export function pushNotice(ok: boolean, text: string) {
  const id = typeof crypto !== "undefined" ? crypto.randomUUID() : `${Date.now()}`;
  notices.update((items) => [{ id, ok, text }, ...items].slice(0, 6));
  setTimeout(() => notices.update((items) => items.filter((item) => item.id !== id)), 5200);
}

/** 统一动作入口：纯引擎结果落账，失败回执写提示（草稿不丢） */
function run(result: ActionResult, successText?: string): ActionResult {
  if (result.ok) {
    ledger.set(result.state);
    if (successText) pushNotice(true, successText);
  } else {
    // 即便被拒，引擎也可能已记账（如冲突登记/整批拒绝），需要落账
    if (result.state !== get(ledger)) ledger.set(result.state);
    pushNotice(false, result.error ?? "操作被拒绝");
  }
  return result;
}

// ---------- 选择器 ----------

export const cues = derived(ledger, ($ledger) => $ledger.cues);
export const terms = derived(ledger, ($ledger) => $ledger.terms);
export const rules = derived(ledger, ($ledger) => $ledger.rules);
export const snapshots = derived(ledger, ($ledger) => $ledger.snapshots);
export const ledgerEntries = derived(ledger, ($ledger) => $ledger.ledger);
export const allBlockers = derived(ledger, ($ledger) => $ledger.blockers);
export const pendingCount = derived(ledger, ($ledger) => pendingBlockers($ledger).length);

export const activeCues = derived(
  [ledger, activeTrackId, selectedCueId],
  ([$ledger, $activeTrackId, $selectedCueId]) =>
    $ledger.cues
      .filter((cue) => cue.locale === $activeTrackId)
      .sort((a, b) => a.start - b.start)
      .map((cue) => ({ ...cue, selected: cue.id === $selectedCueId }))
);

export const selectedCue = derived([ledger, selectedCueId], ([$ledger, $selectedCueId]) =>
  cueById($ledger, $selectedCueId)
);

export const selectedBlockers = derived([ledger, selectedCueId], ([$ledger, $selectedCueId]) =>
  blockersForCue($ledger, $selectedCueId)
);

export function cueRevision(id: string): number {
  return cueById(get(ledger), id)?.revision ?? 0;
}

// ---------- 动作封装 ----------

export function updateCue(
  id: string,
  patch: Partial<Pick<Cue, "source" | "translated" | "start" | "end" | "reviewerNote">>,
  options: { baseRevision?: number; silent?: boolean } = {}
) {
  const result = run(
    editCue(get(ledger), { cueId: id, patch, baseRevision: options.baseRevision, deviceId: get(deviceId) })
  );
  if (result.ok && !options.silent) pushNotice(true, `字幕 ${id} 已登记 r${result.state.cues.find((c) => c.id === id)?.revision}`);
  return result;
}

export function submitForReview(id: string) {
  const base = cueById(get(ledger), id)?.revision ?? 0;
  return run(submitCue(get(ledger), { cueId: id, baseRevision: base, deviceId: get(deviceId) }), `字幕 ${id} 已提交审校（r${base} → 占住）`);
}

export function reviewSelected(id: string, approved: boolean, note = "") {
  return run(
    reviewCue(get(ledger), { cueId: id, approved, note, deviceId: get(deviceId) }),
    approved ? `字幕 ${id} 审校通过，占用已释放` : `字幕 ${id} 已退回修改`
  );
}

export function changeTerm(id: string, patch: { target?: string; status?: "建议" | "已锁定" }) {
  const result = run(updateTerm(get(ledger), { termId: id, patch, deviceId: get(deviceId) }));
  if (result.ok) {
    pushNotice(
      true,
      (result.affectedCueIds?.length ?? 0) > 0
        ? `术语 ${id} 已升版，${result.affectedCueIds!.join("、")} 因旧术语作废，已重进审校`
        : `术语 ${id} 已升版登记`
    );
  }
  return result;
}

export function attachTerm(cueId: string, termId: string) {
  return run(
    attachTermRef(get(ledger), { cueId, termId, deviceId: get(deviceId) }),
    `字幕 ${cueId} 已引用术语 ${termId} 当前修订`
  );
}

export function rebaseCue(cueId: string) {
  return run(
    rebaseCueToTerms(get(ledger), { cueId, deviceId: get(deviceId) }),
    `字幕 ${cueId} 已按新术语重进审校`
  );
}

export function settleBlocker(blockerId: string, resolution: "resubmit" | "withdraw") {
  return run(
    resolveBlocker(get(ledger), { blockerId, resolution, deviceId: get(deviceId) }),
    resolution === "withdraw" ? "已撤回冲突提交" : "已基于最新版本重新提交"
  );
}

export function saveSnapshot(name?: string) {
  const result = run(
    freezeSnapshot(get(ledger), { deviceId: get(deviceId), name }),
    "交付快照已冻结：各语言字幕、术语、审校规则"
  );
  return result.state.snapshots[0]?.id;
}

export function publishSnapshot(snapshotId: string, failLocales: string[] = []) {
  return run(exportBatch(get(ledger), { snapshotId, failLocales, deviceId: get(deviceId) }));
}

export function editRuleBody(rule: ReviewRule, body: string) {
  return run(
    updateRule(get(ledger), { ruleId: rule.id, patch: { body }, deviceId: get(deviceId) }),
    `审校规则 ${rule.id} 已升版 r${rule.revision + 1}`
  );
}

export function resetDemo() {
  if (!browser) return;
  localStorage.removeItem(KEY_V2);
  ledger.set(freshState());
  pushNotice(true, "已恢复演示现场（基准修订 r1）");
}

// ---------- 兼容旧 UI 的时间轴辅助（也全部走修订账） ----------

export function nudgeCue(id: string, delta: number) {
  const cue = cueById(get(ledger), id);
  if (!cue) return;
  updateCue(
    id,
    {
      start: Math.max(0, Number((cue.start + delta).toFixed(1))),
      end: Math.max(cue.start + 0.5, Number((cue.end + delta).toFixed(1)))
    },
    { baseRevision: cue.revision, silent: true }
  );
}

export function splitCue(id: string) {
  const state = get(ledger);
  const cue = cueById(state, id);
  if (!cue || cue.end - cue.start < 1) return;
  // 拆分：原条改结束时间记一笔，新条以 r1 起账
  const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
  run(
    editCue(state, {
      cueId: id,
      deviceId: get(deviceId),
      baseRevision: cue.revision,
      patch: { end: middle }
    })
  );
  const after = get(ledger);
  const parent = cueById(after, id)!;
  const newCue: Cue = {
    id: crypto.randomUUID(),
    locale: parent.locale,
    start: middle,
    end: cue.end,
    source: parent.source,
    translated: "",
    status: "待译",
    translator: get(deviceId),
    reviewerNote: "",
    revision: 1,
    termRefs: []
  };
  const next: LedgerState = structuredClone(after);
  next.cues.push(newCue);
  next.ledger.unshift({
    seq: next.nextSeq++,
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    entityKind: "cue",
    entityId: newCue.id,
    locale: newCue.locale,
    action: "拆分字幕",
    deviceId: get(deviceId),
    baseRevision: 0,
    newRevision: 1,
    fields: [{ field: "snapshot", before: `由 ${id} 拆分`, after: newCue.id }]
  });
  ledger.set(next);
  selectedCueId.set(newCue.id);
}

export function mergeNext(id: string) {
  const state = get(ledger);
  const list = state.cues
    .filter((cue) => cue.locale === get(activeTrackId))
    .sort((a, b) => a.start - b.start);
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const nextCue = list[index + 1];
  if (!current || !nextCue) return;
  const mergedText = `${current.translated} ${nextCue.translated}`.trim();
  const next: LedgerState = structuredClone(state);
  next.cues = next.cues.filter((cue) => cue.id !== nextCue.id);
  const target = next.cues.find((cue) => cue.id === id)!;
  target.end = nextCue.end;
  target.translated = mergedText;
  target.status = "翻译中";
  target.revision += 1;
  next.ledger.unshift({
    seq: next.nextSeq++,
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    entityKind: "cue",
    entityId: target.id,
    locale: target.locale,
    action: "合并下一条字幕",
    deviceId: get(deviceId),
    baseRevision: current.revision,
    newRevision: target.revision,
    fields: [
      { field: "end", before: current.end, after: target.end },
      { field: "translated", before: current.translated, after: mergedText }
    ]
  });
  run({ ok: true, state: next });
}
