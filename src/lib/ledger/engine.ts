/**
 * 修订账引擎：所有业务动作都是纯函数 (state, input) => ActionResult。
 *
 * 不变量：
 *  - 每笔改动登记 deviceId / baseRevision / fields，实体 revision 单调递增；
 *  - 术语升版后，引用旧修订号的“待审”字幕立即失效、重进审校，并记录 causedBy；
 *  - 同字幕并发提交：先到者持锁，后到者产生 submit-conflict 阻塞并看到最新阻塞项；
 *  - 未决阻塞（冲突 + 术语作废）达到容量上限，整批发布拒绝，草稿一字不动；
 *  - 快照冻结各语言字幕/术语/审校规则；冻结中不得覆盖“已通过”结论；
 *  - 导出逐语言推进，失败只保留错误标记，重试只补未完成语言。
 */
import type {
  ActionResult,
  Blocker,
  Cue,
  CueStatus,
  FieldChange,
  FieldKey,
  GlossaryTerm,
  LedgerState,
  ReviewRule,
  RevisionEntry,
  Snapshot,
  TermRef
} from "./types.js";

export interface Actor {
  deviceId: string;
}

export interface EditCueInput extends Actor {
  cueId: string;
  /** 提交方所依据的修订号；与当前不符说明基于过期版本（乐观锁） */
  baseRevision?: number;
  patch: Partial<Pick<Cue, "source" | "translated" | "start" | "end" | "reviewerNote">>;
}

export interface SubmitCueInput extends Actor {
  cueId: string;
  baseRevision: number;
}

export interface ReviewCueInput extends Actor {
  cueId: string;
  approved: boolean;
  note?: string;
}

export interface UpdateTermInput extends Actor {
  termId: string;
  patch: Partial<Pick<GlossaryTerm, "target" | "status">>;
}

export interface AttachRefInput extends Actor {
  cueId: string;
  termId: string;
}

export interface RebaseCueInput extends Actor {
  cueId: string;
}

export interface ResolveBlockerInput extends Actor {
  blockerId: string;
  resolution: "resubmit" | "withdraw";
}

export interface ExportBatchInput extends Actor {
  snapshotId: string;
  /** 模拟本次导出失败的语言（已完成语言会被跳过，不会被回退） */
  failLocales?: string[];
}

// ---------- 基础工具 ----------

export function uid(prefix = "id"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function clone(state: LedgerState): LedgerState {
  return structuredClone(state);
}

function appendEntry(
  state: LedgerState,
  entry: Omit<RevisionEntry, "seq" | "id" | "time"> & { time?: string }
): RevisionEntry {
  const full: RevisionEntry = {
    seq: state.nextSeq,
    id: uid("rev"),
    time: entry.time ?? new Date().toISOString(),
    ...entry
  };
  state.ledger.unshift(full);
  state.nextSeq += 1;
  return full;
}

function diffFields<T extends object>(before: T, after: T, keys: FieldKey[]): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of keys) {
    const key = field.split(":")[0] as keyof T;
    if (before[key] !== after[key]) {
      changes.push({ field, before: before[key], after: after[key] });
    }
  }
  return changes;
}

function reject(state: LedgerState, error: string): ActionResult {
  return { ok: false, state, error };
}

// ---------- 选择器 ----------

export function cueById(state: LedgerState, cueId: string): Cue | undefined {
  return state.cues.find((cue) => cue.id === cueId);
}

export function termById(state: LedgerState, termId: string): GlossaryTerm | undefined {
  return state.terms.find((term) => term.id === termId);
}

export function pendingBlockers(state: LedgerState, locales?: string[]): Blocker[] {
  return state.blockers.filter(
    (blocker) =>
      blocker.status === "待处理" &&
      (!locales || locales.length === 0 || locales.includes(blocker.locale))
  );
}

export function blockersForCue(state: LedgerState, cueId: string): Blocker[] {
  return state.blockers
    .filter((blocker) => blocker.cueId === cueId)
    .sort((a, b) => (a.time < b.time ? 1 : -1));
}

/** 仍在冻结中的快照 = 还有语言没有导出完成（未导出或失败） */
export function activeFrozenSnapshot(state: LedgerState, snapshotId?: string): Snapshot | undefined {
  const active = state.snapshots.filter((snapshot) =>
    Object.values(snapshot.exportStatus).some((status) => status !== "已完成")
  );
  if (snapshotId) return active.find((snapshot) => snapshot.id === snapshotId);
  return active.sort((a, b) => (a.time < b.time ? 1 : -1))[0];
}

/** 该字幕在冻结中是否被钉为“已通过”结论 —— 冻结期间任何修改不得覆盖它 */
export function isProtectedByFreeze(state: LedgerState, cueId: string): Snapshot | undefined {
  for (const snapshot of state.snapshots) {
    if (!Object.values(snapshot.exportStatus).some((status) => status !== "已完成")) continue;
    for (const locale of Object.keys(snapshot.frozen)) {
      const frozen = snapshot.frozen[locale].cues.find((cue) => cue.id === cueId);
      if (frozen && frozen.status === "已通过") return snapshot;
    }
  }
  return undefined;
}

/** 被旧术语/旧审校拖住的字幕：引用的术语修订号落后于当前术语 */
export function staleTermCues(state: LedgerState): Array<{ cue: Cue; refs: TermRef[] }> {
  return state.cues
    .map((cue) => {
      const refs = cue.termRefs.filter((ref) => {
        const term = termById(state, ref.termId);
        return term && term.revision > ref.termRevision;
      });
      return { cue, refs };
    })
    .filter((item) => item.refs.length > 0);
}

export function localesOf(state: LedgerState): string[] {
  return [...new Set(state.cues.map((cue) => cue.locale))].sort();
}

// ---------- 动作 ----------

const CUE_FIELDS: FieldKey[] = ["source", "translated", "start", "end", "status", "note"];

/** 编辑字幕字段；冻结中已通过字幕受保护；带 baseRevision 时做乐观锁校验 */
export function editCue(state: LedgerState, input: EditCueInput): ActionResult {
  const original = cueById(state, input.cueId);
  if (!original) return reject(state, `字幕 ${input.cueId} 不存在`);
  if (input.baseRevision !== undefined && input.baseRevision !== original.revision) {
    return reject(
      state,
      `基础版本过期：本端基于 r${input.baseRevision}，当前已到 r${original.revision}，请刷新后再改`
    );
  }
  const freeze = isProtectedByFreeze(state, input.cueId);
  if (freeze) {
    const touching = Object.keys(input.patch).some((key) => key !== "reviewerNote");
    if (touching) {
      return reject(
        state,
        `快照「${freeze.name}」冻结期间，已通过结论不得被修改覆盖（可添加审校备注）`
      );
    }
  }

  const next = clone(state);
  const cue = cueById(next, input.cueId)!;
  const before = structuredClone({
    source: cue.source,
    translated: cue.translated,
    start: cue.start,
    end: cue.end,
    status: cue.status,
    reviewerNote: cue.reviewerNote
  });
  Object.assign(cue, input.patch);
  const after = {
    source: cue.source,
    translated: cue.translated,
    start: cue.start,
    end: cue.end,
    status: cue.status,
    reviewerNote: cue.reviewerNote
  };
  const fields = diffFields(before, after, CUE_FIELDS);
  if (fields.length === 0) return reject(state, "没有字段变化");
  cue.revision += 1;

  appendEntry(next, {
    entityKind: "cue",
    entityId: cue.id,
    locale: cue.locale,
    action: "编辑字幕",
    deviceId: input.deviceId,
    baseRevision: original.revision,
    newRevision: cue.revision,
    fields
  });
  return { ok: true, state: next };
}

/**
 * 提交审校（并发占用）：
 *  - 该字幕有待处理阻塞（冲突/术语作废）→ 拒绝，回传最新阻塞项；
 *  - 无锁 → 当前设备先到者占住，进入待审；
 *  - 锁在别的设备 → 后到者拿到冲突，并刷新为最新阻塞项。
 */
export function submitCue(state: LedgerState, input: SubmitCueInput): ActionResult {
  const original = cueById(state, input.cueId);
  if (!original) return reject(state, `字幕 ${input.cueId} 不存在`);

  // 后到者在冲突未决期间再次提交：先把阻塞项刷新为“最新阻塞项”再拒绝
  const existingConflict = state.blockers.find(
    (blocker) =>
      blocker.cueId === input.cueId &&
      blocker.kind === "submit-conflict" &&
      blocker.status === "待处理"
  );
  if (existingConflict) {
    const refreshed = clone(state);
    const conflict = refreshed.blockers.find((item) => item.id === existingConflict.id)!;
    const liveCue = cueById(refreshed, input.cueId)!;
    conflict.deviceId = input.deviceId;
    conflict.baseRevision = input.baseRevision;
    conflict.time = new Date().toISOString();
    conflict.detail = {
      ...conflict.detail,
      challengerDevice: input.deviceId,
      challengerBaseRevision: input.baseRevision,
      currentRevision: liveCue.revision,
      currentStatus: liveCue.status
    };
    conflict.message = `并发提交冲突：${conflict.detail.holderDevice} 已先占住字幕 ${input.cueId}（基于 r${conflict.detail.holderBaseRevision}），${input.deviceId} 的最新提交（基于 r${input.baseRevision}，当前 r${liveCue.revision}）仍在冲突队列`;
    return reject(refreshed, conflict.message);
  }

  const live = pendingBlockers(state).find((blocker) => blocker.cueId === input.cueId);
  if (live) {
    return reject(
      state,
      `提交被阻塞项「${live.message}」挡住，请先处理最新阻塞项后再提交`
    );
  }

  const next = clone(state);
  const cue = cueById(next, input.cueId)!;

  if (cue.lock && cue.lock.deviceId !== input.deviceId) {
    // 后到者：登记/刷新冲突阻塞项（同字幕只保留一条待处理冲突，内容刷新为最新）
    let blocker = next.blockers.find(
      (item) =>
        item.cueId === cue.id && item.kind === "submit-conflict" && item.status === "待处理"
    );
    const detail = {
      holderDevice: cue.lock.deviceId,
      holderBaseRevision: cue.lock.baseRevision,
      holderSince: cue.lock.since,
      challengerDevice: input.deviceId,
      challengerBaseRevision: input.baseRevision,
      currentRevision: cue.revision,
      currentStatus: cue.status
    };
    const message = `并发提交冲突：${cue.lock.deviceId} 已先占住字幕 ${cue.id}（基于 r${cue.lock.baseRevision}），${input.deviceId} 的提交（基于 r${input.baseRevision}）进入冲突`;
    if (blocker) {
      blocker.deviceId = input.deviceId;
      blocker.baseRevision = input.baseRevision;
      blocker.message = message;
      blocker.detail = detail;
      blocker.time = new Date().toISOString();
    } else {
      blocker = {
        id: uid("blk"),
        kind: "submit-conflict",
        locale: cue.locale,
        cueId: cue.id,
        message,
        status: "待处理",
        deviceId: input.deviceId,
        baseRevision: input.baseRevision,
        detail,
        time: new Date().toISOString()
      };
      next.blockers.unshift(blocker);
    }
    appendEntry(next, {
      entityKind: "cue",
      entityId: cue.id,
      locale: cue.locale,
      action: "并发提交冲突",
      deviceId: input.deviceId,
      baseRevision: input.baseRevision,
      newRevision: cue.revision,
      fields: [{ field: "status", before: cue.status, after: "冲突待决" }],
      rejected: message
    });
    return { ok: false, state: next, error: message };
  }

  if (input.baseRevision !== cue.revision) {
    return reject(
      state,
      `基础版本过期：本端基于 r${input.baseRevision}，当前已到 r${cue.revision}`
    );
  }

  const beforeStatus = cue.status;
  cue.status = "待审";
  cue.lock = {
    deviceId: input.deviceId,
    baseRevision: cue.revision,
    since: new Date().toISOString()
  };
  cue.revision += 1;
  appendEntry(next, {
    entityKind: "cue",
    entityId: cue.id,
    locale: cue.locale,
    action: "提交审校",
    deviceId: input.deviceId,
    baseRevision: input.baseRevision,
    newRevision: cue.revision,
    fields: [{ field: "status", before: beforeStatus, after: "待审" }]
  });
  return { ok: true, state: next };
}

/** 审校结论：有待处理阻塞的字幕不得出结论；结论一出即释放占用 */
export function reviewCue(state: LedgerState, input: ReviewCueInput): ActionResult {
  const cue = cueById(state, input.cueId);
  if (!cue) return reject(state, `字幕 ${input.cueId} 不存在`);
  // 术语作废会推翻审校内容，必须挡住；并发冲突是后到者与占住者之争，不挡先到者的结论
  const live = pendingBlockers(state).find(
    (blocker) => blocker.cueId === input.cueId && blocker.kind === "term-invalidation"
  );
  if (live) return reject(state, `存在未决阻塞项，不能出审校结论：${live.message}`);
  if (cue.status !== "待审") return reject(state, `字幕当前为「${cue.status}」，不在待审队列`);

  const next = clone(state);
  const target = cueById(next, input.cueId)!;
  const beforeStatus = target.status;
  target.status = input.approved ? "已通过" : "退回";
  target.reviewerNote = input.note ?? target.reviewerNote;
  target.lock = undefined;
  target.revision += 1;
  appendEntry(next, {
    entityKind: "cue",
    entityId: target.id,
    locale: target.locale,
    action: input.approved ? "审校通过" : "退回修改",
    deviceId: input.deviceId,
    baseRevision: beforeStatus === target.status ? target.revision - 1 : target.revision - 1,
    newRevision: target.revision,
    fields: [
      { field: "status", before: beforeStatus, after: target.status },
      ...(input.note ? [{ field: "note" as FieldKey, before: cue.reviewerNote, after: input.note }] : [])
    ]
  });
  return { ok: true, state: next };
}

/** 译员把字幕钉到某条术语的当前修订号（建立引用） */
export function attachTermRef(state: LedgerState, input: AttachRefInput): ActionResult {
  const cue = cueById(state, input.cueId);
  const term = termById(state, input.termId);
  if (!cue) return reject(state, `字幕 ${input.cueId} 不存在`);
  if (!term) return reject(state, `术语 ${input.termId} 不存在`);

  const next = clone(state);
  const target = cueById(next, input.cueId)!;
  const existing = target.termRefs.find((ref) => ref.termId === term.id);
  const before = existing?.termRevision ?? null;
  if (existing) existing.termRevision = term.revision;
  else target.termRefs.push({ termId: term.id, termRevision: term.revision });
  target.revision += 1;
  appendEntry(next, {
    entityKind: "cue",
    entityId: target.id,
    locale: target.locale,
    action: "引用术语",
    deviceId: input.deviceId,
    baseRevision: cue.revision,
    newRevision: target.revision,
    fields: [{ field: "translated", before: `term:${term.id}@r${before ?? "none"}`, after: `term:${term.id}@r${term.revision}` }],
    causedBy: `term:${term.id}`
  });
  return { ok: true, state: next };
}

/**
 * 术语改译/锁定：术语修订号 +1；
 * 引用旧修订号且处于“待审”的字幕立即失效重进审校，逐条写明由哪条术语引起；
 * 冻结中已通过的字幕受保护，不被作废。
 */
export function updateTerm(state: LedgerState, input: UpdateTermInput): ActionResult {
  const term = termById(state, input.termId);
  if (!term) return reject(state, `术语 ${input.termId} 不存在`);

  const next = clone(state);
  const target = termById(next, input.termId)!;
  const before = structuredClone({ target: target.target, status: target.status });
  Object.assign(target, input.patch);
  const fields = diffFields(before, { target: target.target, status: target.status }, [
    "target",
    "status:term"
  ]);
  if (fields.length === 0) return reject(state, "术语没有变化");
  const fromRevision = target.revision;
  target.revision += 1;

  const affected: string[] = [];
  const protectedCues: string[] = [];
  for (const cue of next.cues) {
    const ref = cue.termRefs.find((item) => item.termId === target.id);
    if (!ref || ref.termRevision >= target.revision) continue;
    if (cue.status !== "待审") {
      // 已通过（无论是否冻结）不在“待审即失效”范围；冻结中的通过结论额外受保护
      if (cue.status === "已通过" && isProtectedByFreeze(next, cue.id)) protectedCues.push(cue.id);
      continue;
    }
    if (isProtectedByFreeze(next, cue.id)) {
      protectedCues.push(cue.id);
      continue;
    }
    const oldStatus: CueStatus = cue.status;
    cue.status = "失效";
    cue.invalidatedBy = {
      kind: "term",
      termId: target.id,
      termSource: target.source,
      fromRevision: ref.termRevision,
      toRevision: target.revision
    };
    cue.lock = undefined; // 旧术语上的审校占用随作废一起释放
    cue.revision += 1;
    affected.push(cue.id);

    const message = `术语「${target.source}」译法由引用的 r${ref.termRevision} 更新到 r${target.revision}，字幕 ${cue.id} 的待审结论作废，须按新术语重进审校`;
    next.blockers.unshift({
      id: uid("blk"),
      kind: "term-invalidation",
      locale: cue.locale,
      cueId: cue.id,
      message,
      status: "待处理",
      detail: {
        termId: target.id,
        termSource: target.source,
        fromRevision: ref.termRevision,
        toRevision: target.revision
      },
      time: new Date().toISOString()
    });
    appendEntry(next, {
      entityKind: "cue",
      entityId: cue.id,
      locale: cue.locale,
      action: "术语改译作废待审",
      deviceId: input.deviceId,
      baseRevision: cue.revision - 1,
      newRevision: cue.revision,
      fields: [{ field: "status", before: oldStatus, after: "失效" }],
      causedBy: `term:${target.id}`
    });
  }

  appendEntry(next, {
    entityKind: "term",
    entityId: target.id,
    locale: target.locale,
    action: "修改术语",
    deviceId: input.deviceId,
    baseRevision: fromRevision,
    newRevision: target.revision,
    fields,
    causedBy: affected.length > 0 ? undefined : undefined
  });

  return {
    ok: true,
    state: next,
    affectedCueIds: protectedCues.length > 0 ? affected : affected
  };
}

/** 译员按新术语修订引用后，重新进入审校 */
export function rebaseCueToTerms(state: LedgerState, input: RebaseCueInput): ActionResult {
  const cue = cueById(state, input.cueId);
  if (!cue) return reject(state, `字幕 ${input.cueId} 不存在`);
  if (cue.status !== "失效" || !cue.invalidatedBy) {
    return reject(state, "该字幕没有待处理的术语作废记录");
  }

  const next = clone(state);
  const target = cueById(next, input.cueId)!;
  const cause = target.invalidatedBy!;
  for (const ref of target.termRefs) {
    const term = termById(next, ref.termId);
    if (term) ref.termRevision = term.revision;
  }
  target.status = "待审";
  target.invalidatedBy = undefined;
  target.lock = {
    deviceId: input.deviceId,
    baseRevision: target.revision,
    since: new Date().toISOString()
  };
  target.revision += 1;

  for (const blocker of next.blockers) {
    if (blocker.cueId === target.id && blocker.kind === "term-invalidation" && blocker.status === "待处理") {
      blocker.status = "已解决";
    }
  }

  appendEntry(next, {
    entityKind: "cue",
    entityId: target.id,
    locale: target.locale,
    action: "按新术语重进审校",
    deviceId: input.deviceId,
    baseRevision: cue.revision,
    newRevision: target.revision,
    fields: [{ field: "status", before: "失效", after: "待审" }],
    causedBy: `term:${cause.termId}`
  });
  return { ok: true, state: next, affectedCueIds: [target.id] };
}

/** 后到者处理并发冲突：撤回，或在占住者审校结束后基于最新版重新提交 */
export function resolveBlocker(state: LedgerState, input: ResolveBlockerInput): ActionResult {
  const blocker = state.blockers.find((item) => item.id === input.blockerId);
  if (!blocker) return reject(state, `阻塞项 ${input.blockerId} 不存在`);
  if (blocker.status !== "待处理") return reject(state, "阻塞项已解决");
  const cue = cueById(state, blocker.cueId);
  if (!cue) return reject(state, "阻塞项对应字幕已不存在");

  const next = clone(state);
  const targetBlocker = next.blockers.find((item) => item.id === input.blockerId)!;
  const target = cueById(next, blocker.cueId)!;
  targetBlocker.status = "已解决";

  if (input.resolution === "withdraw") {
    appendEntry(next, {
      entityKind: "cue",
      entityId: target.id,
      locale: target.locale,
      action: "撤回冲突提交",
      deviceId: input.deviceId,
      baseRevision: target.revision,
      newRevision: target.revision,
      fields: []
    });
    return { ok: true, state: next };
  }

  // resubmit：必须等先到者的锁释放（审校已有结论），否则仍是占住状态
  if (target.lock && target.lock.deviceId !== input.deviceId) {
    return reject(state, "先到者仍占住该字幕，请等审校结论出来后再重新提交");
  }
  const beforeStatus = target.status;
  target.status = "待审";
  target.lock = {
    deviceId: input.deviceId,
    baseRevision: target.revision,
    since: new Date().toISOString()
  };
  target.revision += 1;
  appendEntry(next, {
    entityKind: "cue",
    entityId: target.id,
    locale: target.locale,
    action: "冲突后重新提交",
    deviceId: input.deviceId,
    baseRevision: target.revision - 1,
    newRevision: target.revision,
    fields: [{ field: "status", before: beforeStatus, after: "待审" }]
  });
  return { ok: true, state: next };
}

/** 修改审校规则，修订号 +1（快照内冻结的是当时的规则版本） */
export function updateRule(
  state: LedgerState,
  input: Actor & { ruleId: string; patch: Partial<Pick<ReviewRule, "body" | "title">> }
): ActionResult {
  const rule = state.rules.find((item) => item.id === input.ruleId);
  if (!rule) return reject(state, `审校规则 ${input.ruleId} 不存在`);
  const next = clone(state);
  const target = next.rules.find((item) => item.id === input.ruleId)!;
  const before = { body: target.body, title: target.title };
  Object.assign(target, input.patch);
  const fields: FieldChange[] = [];
  if (before.body !== target.body) fields.push({ field: "ruleBody", before: before.body, after: target.body });
  if (before.title !== target.title) fields.push({ field: "ruleBody", before: before.title, after: target.title });
  if (fields.length === 0) return reject(state, "规则没有变化");
  target.revision += 1;
  appendEntry(next, {
    entityKind: "rule",
    entityId: target.id,
    locale: target.locale,
    action: "修改审校规则",
    deviceId: input.deviceId,
    baseRevision: rule.revision,
    newRevision: target.revision,
    fields
  });
  return { ok: true, state: next };
}

/** 冻结交付快照：当时各语言字幕、术语、审校规则全部入冻 */
export function freezeSnapshot(state: LedgerState, input: Actor & { name?: string }): ActionResult {
  const next = clone(state);
  const time = new Date().toISOString();
  const locales = localesOf(next);
  const frozen: Snapshot["frozen"] = {};
  for (const locale of locales) {
    frozen[locale] = {
      cues: next.cues
        .filter((cue) => cue.locale === locale)
        .map((cue) => ({
          id: cue.id,
          status: cue.status,
          translated: cue.translated,
          revision: cue.revision,
          termRefs: structuredClone(cue.termRefs)
        })),
      terms: next.terms
        .filter((term) => term.locale === locale || term.locale === "*")
        .map((term) => ({ id: term.id, target: term.target, status: term.status, revision: term.revision })),
      rules: next.rules
        .filter((rule) => rule.locale === locale || rule.locale === "*")
        .map((rule) => ({ id: rule.id, body: rule.body, revision: rule.revision }))
    };
  }
  const exportStatus: Snapshot["exportStatus"] = {};
  for (const locale of locales) exportStatus[locale] = "未导出";

  const snapshot: Snapshot = {
    id: uid("snap"),
    name: input.name ?? `交付快照 ${next.snapshots.length + 1}`,
    time,
    frozen,
    exportStatus
  };
  next.snapshots.unshift(snapshot);
  appendEntry(next, {
    entityKind: "snapshot",
    entityId: snapshot.id,
    locale: "*",
    action: "冻结交付快照",
    deviceId: input.deviceId,
    baseRevision: 0,
    newRevision: 0,
    fields: [{ field: "snapshot", before: null, after: { locales, cueCount: next.cues.length, termCount: next.terms.length } }]
  });
  return { ok: true, state: next };
}

/**
 * 整批导出（发布）：
 *  1) 先盘点待决容量：未决冲突 + 作废条目达到上限 → 整批拒绝，草稿不丢；
 *  2) 逐语言导出：已是“已完成”的语言跳过（保留），其余成功置完成、失败置失败；
 *  3) 重试本动作即可，只补未完成/失败语言。
 */
export function exportBatch(state: LedgerState, input: ExportBatchInput): ActionResult {
  const snapshot = state.snapshots.find((item) => item.id === input.snapshotId);
  if (!snapshot) return reject(state, `快照 ${input.snapshotId} 不存在`);

  const locales = Object.keys(snapshot.exportStatus);
  const pending = pendingBlockers(state, locales);
  if (pending.length >= state.pendingCapacity) {
    const next = clone(state);
    const reason = `待决容量 ${next.pendingCapacity} 已满（冲突 ${pending.filter((b) => b.kind === "submit-conflict").length} 条 + 作废 ${pending.filter((b) => b.kind === "term-invalidation").length} 条），整批发布被拒绝，草稿保留`;
    appendEntry(next, {
      entityKind: "batch",
      entityId: snapshot.id,
      locale: "*",
      action: "整批发布",
      deviceId: input.deviceId,
      baseRevision: 0,
      newRevision: 0,
      fields: [{ field: "deliverable", before: "申请发布", after: "拒绝" }],
      rejected: reason
    });
    return { ok: false, state: next, error: reason };
  }

  const next = clone(state);
  const target = next.snapshots.find((item) => item.id === input.snapshotId)!;
  const failSet = new Set(input.failLocales ?? []);
  const done: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const locale of locales) {
    if (target.exportStatus[locale] === "已完成") {
      skipped.push(locale);
      continue;
    }
    if (failSet.has(locale)) {
      target.exportStatus[locale] = "失败";
      failed.push(locale);
    } else {
      target.exportStatus[locale] = "已完成";
      done.push(locale);
    }
  }
  target.exportError = failed.length
    ? `语言 ${failed.join("、")} 导出失败，已完成语言保留，可重试只补未完成语言`
    : undefined;

  appendEntry(next, {
    entityKind: "batch",
    entityId: target.id,
    locale: "*",
    action: failed.length ? "分批导出（含失败）" : "整批发布",
    deviceId: input.deviceId,
    baseRevision: 0,
    newRevision: 0,
    fields: [
      { field: "deliverable", before: "导出前", after: { 完成: done, 失败: failed, 保留已完成: skipped } }
    ]
  });
  return {
    ok: failed.length === 0,
    state: next,
    error: target.exportError,
    affectedCueIds: []
  };
}

/** 快照与当前现场的漂移：冻结后被改过的字幕/术语/规则 */
export function snapshotDrift(
  state: LedgerState,
  snapshotId: string
): { cues: Cue[]; terms: GlossaryTerm[]; rules: ReviewRule[] } {
  const snapshot = state.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) return { cues: [], terms: [], rules: [] };
  const cueDrift: Cue[] = [];
  for (const locale of Object.keys(snapshot.frozen)) {
    for (const frozenCue of snapshot.frozen[locale].cues) {
      const live = state.cues.find((cue) => cue.id === frozenCue.id);
      if (live && live.revision !== frozenCue.revision) cueDrift.push(live);
    }
  }
  const frozenTermRevs = new Map<string, number>();
  for (const locale of Object.keys(snapshot.frozen)) {
    for (const term of snapshot.frozen[locale].terms) {
      // 同一全局术语可能出现在多个语言分块，保留最早冻结修订即可（冻结时一致）
      if (!frozenTermRevs.has(term.id)) frozenTermRevs.set(term.id, term.revision);
    }
  }
  const termDrift = state.terms.filter((term) => {
    const rev = frozenTermRevs.get(term.id);
    return rev !== undefined && rev !== term.revision;
  });
  const frozenRuleRevs = new Map<string, number>();
  for (const locale of Object.keys(snapshot.frozen)) {
    for (const rule of snapshot.frozen[locale].rules) {
      if (!frozenRuleRevs.has(rule.id)) frozenRuleRevs.set(rule.id, rule.revision);
    }
  }
  const ruleDrift = state.rules.filter((rule) => {
    const rev = frozenRuleRevs.get(rule.id);
    return rev !== undefined && rev !== rule.revision;
  });
  return { cues: cueDrift, terms: termDrift, rules: ruleDrift };
}
