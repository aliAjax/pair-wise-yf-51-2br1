import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateLegacy } from "../src/lib/ledger/migrate.ts";
import {
  attachTermRef,
  blockersForCue,
  cueById,
  editCue,
  exportBatch,
  freezeSnapshot,
  isProtectedByFreeze,
  pendingBlockers,
  rebaseCueToTerms,
  resolveBlocker,
  reviewCue,
  snapshotDrift,
  staleTermCues,
  submitCue,
  termById,
  updateRule,
  updateTerm
} from "../src/lib/ledger/engine.ts";
import type { LedgerState } from "../src/lib/ledger/types.ts";

const DEV_A = "device-A-林岚";
const DEV_B = "device-B-周野";
const REVIEWER = "device-审校-顾宁";

function seed(): LedgerState {
  const { state } = migrateLegacy({
    tracks: [
      { id: "en", locale: "en" },
      { id: "ja", locale: "ja" }
    ],
    cues: [
      { id: "c-en-1", trackId: "en", start: 0, end: 2.8, source: "潮汐退去。", translated: "As the tide recedes.", status: "待审", translator: "林岚" },
      { id: "c-en-2", trackId: "en", start: 3, end: 6, source: "加固码头。", translated: "Reinforce the pier.", status: "翻译中", translator: "周野" },
      { id: "c-ja-1", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去。", translated: "潮が引く。", status: "待审", translator: "周野" }
    ],
    terms: [
      { id: "g1", locale: "en", source: "潮汐", target: "tide", status: "已锁定", owner: "管理员" },
      { id: "g2", locale: "en", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
    ]
  });
  return state;
}

test("迁移：旧数据没有修订号 → 基准修订 1，且幂等登记一笔迁移账", () => {
  const report = migrateLegacy({
    cues: [{ id: "x1", trackId: "en", status: "待审" }],
    terms: [{ id: "t1", source: "码头", target: "pier" }]
  });
  assert.equal(report.alreadyCurrent, false);
  assert.deepEqual(report.migratedCues, ["x1"]);
  assert.deepEqual(report.migratedTerms, ["t1"]);
  assert.equal(report.state.cues[0].revision, 1);
  assert.equal(report.state.terms[0].revision, 1);
  assert.equal(report.state.ledger[0].action, "迁移为基准修订");

  const again = migrateLegacy(report.state);
  assert.equal(again.alreadyCurrent, true);
  assert.equal(again.state.ledger.length, report.state.ledger.length);
});

test("修订账：每笔编辑登记设备、基础版本、字段，修订号单调递增", () => {
  let s = seed();
  const r = editCue(s, { deviceId: DEV_A, cueId: "c-en-2", baseRevision: 1, patch: { translated: "Strengthen the pier." } });
  assert.ok(r.ok);
  s = r.state;
  const cue = cueById(s, "c-en-2")!;
  assert.equal(cue.revision, 2);
  const entry = s.ledger[0];
  assert.equal(entry.deviceId, DEV_A);
  assert.equal(entry.baseRevision, 1);
  assert.equal(entry.newRevision, 2);
  assert.deepEqual(entry.fields, [{ field: "translated", before: "Reinforce the pier.", after: "Strengthen the pier." }]);

  // 乐观锁：基础版本过期被拒，state 原样
  const stale = editCue(s, { deviceId: DEV_B, cueId: "c-en-2", baseRevision: 1, patch: { translated: "x" } });
  assert.equal(stale.ok, false);
  assert.match(stale.error!, /基础版本过期/);
  assert.equal(cueById(stale.state, "c-en-2")!.translated, "Strengthen the pier.");
});

test("术语改译：引用旧术语的待审字幕立即失效、重进审校，并写明哪条术语引起", () => {
  let s = seed();
  let r = attachTermRef(s, { deviceId: DEV_A, cueId: "c-en-1", termId: "g1" });
  s = r.state; // 字幕 r2，引用 g1@r1
  const jaAttach = attachTermRef(s, { deviceId: DEV_B, cueId: "c-ja-1", termId: "g1" });
  s = jaAttach.state;

  const term = termById(s, "g1")!;
  r = updateTerm(s, { deviceId: "术语管理员", termId: "g1", patch: { target: "tidal flow" } });
  assert.ok(r.ok);
  s = r.state;

  const en = cueById(s, "c-en-1")!;
  const ja = cueById(s, "c-ja-1")!;
  assert.equal(en.status, "失效");
  assert.equal(en.invalidatedBy?.termId, "g1");
  assert.equal(en.invalidatedBy?.fromRevision, 1);
  assert.equal(en.invalidatedBy?.toRevision, 2);
  assert.equal(ja.status, "失效");

  const invalidationEntry = s.ledger.find((e) => e.action === "术语改译作废待审");
  assert.equal(invalidationEntry?.causedBy, "term:g1");

  // 非待审字幕（c-en-2 翻译中）不失效
  assert.equal(cueById(s, "c-en-2")!.status, "翻译中");
  // stale 选择器能看到被旧术语拖住
  assert.equal(staleTermCues(s).length, 2);

  // 译员按新术语改完 → 重进审校，阻塞解除
  const rebased = rebaseCueToTerms(s, { deviceId: DEV_A, cueId: "c-en-1" });
  assert.ok(rebased.ok);
  s = rebased.state;
  assert.equal(cueById(s, "c-en-1")!.status, "待审");
  assert.equal(cueById(s, "c-en-1")!.invalidatedBy, undefined);
  assert.equal(blockersForCue(s, "c-en-1")[0].status, "已解决");
});

test("并发提交：先到者占住，后到者看到冲突与最新阻塞项", () => {
  let s = seed();
  // c-en-2 翻译中 r1
  const first = submitCue(s, { deviceId: DEV_A, cueId: "c-en-2", baseRevision: 1 });
  assert.ok(first.ok);
  s = first.state;
  assert.equal(cueById(s, "c-en-2")!.lock?.deviceId, DEV_A);

  const second = submitCue(s, { deviceId: DEV_B, cueId: "c-en-2", baseRevision: 1 });
  assert.equal(second.ok, false);
  s = second.state;
  assert.match(second.error!, /并发提交冲突/);
  let blockers = blockersForCue(s, "c-en-2");
  assert.equal(blockers[0].kind, "submit-conflict");
  assert.equal(blockers[0].detail.holderDevice, DEV_A);
  assert.equal(blockers[0].detail.challengerDevice, DEV_B);

  // 占住者的审校结论不被冲突挡住；结论后锁释放
  const review = reviewCue(s, { deviceId: REVIEWER, cueId: "c-en-2", approved: true });
  assert.ok(review.ok, review.error);
  s = review.state;
  assert.equal(cueById(s, "c-en-2")!.status, "已通过");
  assert.equal(cueById(s, "c-en-2")!.lock, undefined);

  // 后到者再次重提仍然被“待处理”冲突挡住；处理阻塞项后基于最新版重提
  const retry = submitCue(s, { deviceId: DEV_B, cueId: "c-en-2", baseRevision: 3 });
  assert.equal(retry.ok, false);
  s = retry.state;
  blockers = blockersForCue(s, "c-en-2");
  // 最新阻塞项应刷新（挑战者修订号、当前修订号）
  assert.equal((blockers[0].detail as { challengerBaseRevision: number }).challengerBaseRevision, 3);

  const resolve = resolveBlocker(s, { deviceId: DEV_B, blockerId: blockers[0].id, resolution: "withdraw" });
  assert.ok(resolve.ok);
  s = resolve.state;
  assert.equal(blockersForCue(s, "c-en-2")[0].status, "已解决");
});

test("待决容量上限：冲突+作废累计到上限，整批发布被拒绝且草稿不丢", () => {
  let s = seed();
  s.pendingCapacity = 3; // 待决容量上限 3：2 条作废 + 1 条冲突即满
  // 2 条待审字幕引用同一术语 → 术语一改同时作废
  s = attachTermRef(s, { deviceId: DEV_A, cueId: "c-en-1", termId: "g1" }).state;
  s = attachTermRef(s, { deviceId: DEV_B, cueId: "c-ja-1", termId: "g1" }).state;
  const draftBefore = cueById(s, "c-en-2")!.translated;
  s = updateTerm(s, { deviceId: "管理员", termId: "g1", patch: { target: "a" } }).state; // 2 条作废

  // 并发冲突 1 条（对 c-en-2：先 A 提交占住，后 B 撞）
  s = submitCue(s, { deviceId: DEV_A, cueId: "c-en-2", baseRevision: 1 }).state;
  s = submitCue(s, { deviceId: DEV_B, cueId: "c-en-2", baseRevision: 1 }).state; // 拒绝但记账

  assert.equal(pendingBlockers(s).length, 3);
  const snap = freezeSnapshot(s, { deviceId: "制作人" });
  s = snap.state;
  const snapshotId = s.snapshots[0].id;

  const publish = exportBatch(s, { deviceId: "制作人", snapshotId });
  assert.equal(publish.ok, false);
  assert.match(publish.error!, /待决容量 3 已满/);
  s = publish.state;
  // 草稿不丢、导出未推进
  assert.equal(cueById(s, "c-en-2")!.translated, draftBefore);
  assert.equal(s.snapshots[0].exportStatus.en, "未导出");
  assert.equal(s.ledger[0].rejected, publish.error);

  // 解决一条冲突后容量腾出（仍有 2 条作废 < 3），整批允许发布
  const conflict = blockersForCue(s, "c-en-2").find((b) => b.status === "待处理")!;
  s = resolveBlocker(s, { deviceId: DEV_B, blockerId: conflict.id, resolution: "withdraw" }).state;
  assert.equal(pendingBlockers(s).length, 2);
  const publish2 = exportBatch(s, { deviceId: "制作人", snapshotId });
  assert.ok(publish2.ok, publish2.error);
  s = publish2.state;
  assert.equal(s.snapshots[0].exportStatus.en, "已完成");
  assert.equal(s.snapshots[0].exportStatus.ja, "已完成");
});

test("快照冻结：冻结期间修改不能覆盖通过结论；导出失败保留已完成语言并只补未完成", () => {
  let s = seed();
  // c-en-1 待审 → 审校通过
  s = submitCue(s, { deviceId: DEV_A, cueId: "c-en-1", baseRevision: 1 }).state;
  s = reviewCue(s, { deviceId: REVIEWER, cueId: "c-en-1", approved: true }).state;
  assert.equal(cueById(s, "c-en-1")!.status, "已通过");

  s = freezeSnapshot(s, { deviceId: "制作人", name: "送审冻结 v1" }).state;
  const snapshotId = s.snapshots[0].id;
  assert.ok(isProtectedByFreeze(s, "c-en-1"));

  // 冻结期间改译文 → 被拒
  const edit = editCue(s, { deviceId: DEV_B, cueId: "c-en-1", baseRevision: 3, patch: { translated: "OVERWRITE" } });
  assert.equal(edit.ok, false);
  assert.match(edit.error!, /冻结期间/);
  s = edit.state;
  assert.notEqual(cueById(s, "c-en-1")!.translated, "OVERWRITE");

  // 冻结期间术语改译也不能作废该通过字幕
  s = attachTermRef(s, { deviceId: DEV_A, cueId: "c-en-1", termId: "g1" }).state;
  // 注：attach 在已通过字幕上仍允许（引用建立），随后改译不得推翻结论
  const termChange = updateTerm(s, { deviceId: "管理员", termId: "g1", patch: { target: "zzz" } });
  s = termChange.state;
  assert.equal(cueById(s, "c-en-1")!.status, "已通过");

  // 规则修改只改现场，冻结内规则仍是旧版（drift 可见）
  const rule = s.rules[0];
  s = updateRule(s, { deviceId: REVIEWER, ruleId: rule.id, patch: { body: "新规则：单行不超过 36 字。" } }).state;
  const drift = snapshotDrift(s, snapshotId);
  assert.ok(drift.rules.some((r) => r.id === rule.id));

  // 导出：ja 失败，en 成功 → en 保留
  const exp1 = exportBatch(s, { deviceId: "制作人", snapshotId, failLocales: ["ja"] });
  assert.equal(exp1.ok, false);
  s = exp1.state;
  assert.equal(s.snapshots[0].exportStatus.en, "已完成");
  assert.equal(s.snapshots[0].exportStatus.ja, "失败");
  assert.match(s.snapshots[0].exportError!, /ja/);

  // 冻结仍在（还有未完成语言），保护继续生效
  assert.ok(isProtectedByFreeze(s, "c-en-1"));

  // 重试只补 ja
  const exp2 = exportBatch(s, { deviceId: "制作人", snapshotId, failLocales: [] });
  assert.ok(exp2.ok, exp2.error);
  s = exp2.state;
  assert.equal(s.snapshots[0].exportStatus.ja, "已完成");
  assert.equal(s.snapshots[0].exportError, undefined);
});

test("快照冻结当时各语言字幕、术语、规则（不再随现场改动而变）", () => {
  let s = seed();
  s = freezeSnapshot(s, { deviceId: "制作人" }).state;
  const snapshot = s.snapshots[0];
  assert.deepEqual(Object.keys(snapshot.frozen).sort(), ["en", "ja"]);
  assert.equal(snapshot.frozen.en.terms.find((t) => t.id === "g1")!.revision, 1);
  s = updateTerm(s, { deviceId: "管理员", termId: "g1", patch: { target: "changed" } }).state;
  // 冻结体内保持 r1
  assert.equal(s.snapshots[0].frozen.en.terms.find((t) => t.id === "g1")!.revision, 1);
});
