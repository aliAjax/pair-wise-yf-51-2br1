<script lang="ts">
  import { onMount } from "svelte";
  import { derived } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import {
    activeCues,
    activeTrackId,
    allBlockers,
    attachTerm,
    changeTerm,
    cues,
    deviceId,
    editRuleBody,
    ledger,
    ledgerEntries,
    mergeNext,
    nudgeCue,
    notices,
    pendingCount,
    publishSnapshot,
    pushNotice,
    rebaseCue,
    resetDemo,
    reviewSelected,
    rules,
    saveSnapshot,
    selectedBlockers,
    selectedCue,
    selectedCueId,
    settleBlocker,
    snapshots,
    splitCue,
    submitForReview,
    terms,
    tracks,
    updateCue
  } from "$lib/stores/subtitles";
  import { snapshotDrift, staleTermCues, termById } from "$lib/ledger/engine";
  import type { Cue } from "$lib/ledger/types";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      const item: Cue = {
        id: crypto.randomUUID(),
        locale: $activeTrackId,
        start,
        end: start + Number(formData.get("duration") ?? 2.5),
        source: String(formData.get("source") ?? ""),
        translated: String(formData.get("translated") ?? ""),
        status: "翻译中",
        translator: $deviceId,
        reviewerNote: "",
        revision: 1,
        termRefs: []
      };
      ledger.update((state) => {
        const next = structuredClone(state);
        next.cues.push(item);
        next.ledger.unshift({
          seq: next.nextSeq++,
          id: crypto.randomUUID(),
          time: new Date().toISOString(),
          entityKind: "cue",
          entityId: item.id,
          locale: item.locale,
          action: "新增字幕",
          deviceId: $deviceId,
          baseRevision: 0,
          newRevision: 1,
          fields: [{ field: "snapshot", before: null, after: { start: item.start, end: item.end } }]
        });
        return next;
      });
      selectedCueId.set(item.id);
      pushNotice(true, `新字幕 ${item.id} 以基准修订 r1 起账`);
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<typeof $activeCues> => $activeCues }));
  const query = createQuery(queryOptions);
  const activeTrack = $derived($tracks.find((track) => track.id === $activeTrackId));
  let reviewNote = $state("");

  // 模拟“两台设备/两名译员”：随时切换当前操作设备
  const devicePresets = ["device-A-林岚", "device-B-周野", "device-审校-顾宁", "device-制作人"];

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  function statusChip(status: string) {
    return status;
  }

  let exportFailLocale = $state("");
  let termDraftTarget = $state<Record<string, string>>({});

  function driftFor(snapshotId: string) {
    return snapshotDrift($ledger, snapshotId);
  }

  const staleList = $derived(staleTermCues($ledger));

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA" || (event.target as HTMLElement)?.tagName === "INPUT") return;
      const list = $activeCues;
      const index = list.findIndex((cue) => cue.id === $selectedCueId);
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") selectedCueId.set(list[Math.min(list.length - 1, index + 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") selectedCueId.set(list[Math.max(0, index - 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "s") splitCue($selectedCueId);
      if (event.key.toLowerCase() === "m") mergeNext($selectedCueId);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveSnapshot();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<svelte:head><title>修订账 · 多语言字幕协作</title></svelte:head>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><b>SUBFLOW</b><span>字幕协作台</span></div>
    <nav><button class="active">修订账时间轴</button><button>审校队列</button><button>术语库</button><button>交付快照</button></nav>
    <div class="device-box">
      <b>当前设备（修订账登记方）</b>
      <select class="input" value={$deviceId} onchange={(e) => deviceId.set(e.currentTarget.value)}>
        {#each devicePresets as d}<option value={d}>{d}</option>{/each}
        {#if !devicePresets.includes($deviceId)}<option value={$deviceId}>{$deviceId}</option>{/if}
      </select>
      <input class="input" placeholder="自定义设备名" value={$deviceId} onchange={(e) => deviceId.set(e.currentTarget.value || "device-anon")} />
      <small>每笔改动按此设备登记；切换设备可模拟两名译员并发提交。</small>
    </div>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>⌘S 冻结快照</span></div>
  </aside>

  <main>
    <header>
      <div><small>纪录片《潮汐线》 · 第 3 集 · 可恢复修订账</small><h1>{m.title()}</h1><p>字幕 / 术语 / 审校结论 / 交付快照全部按设备、基础版本、字段入账，可回放可恢复。</p></div>
      <div class="header-actions">
        <select value={$activeTrackId} onchange={(event) => { activeTrackId.set(event.currentTarget.value); const first = $cues.find((c) => c.locale === event.currentTarget.value); if (first) selectedCueId.set(first.id); }}>
          {#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}
        </select>
        <button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button>
        <button onclick={resetDemo}>重置演示</button>
      </div>
    </header>

    {#if $notices.length}
      <div class="toasts">
        {#each $notices as notice}
          <div class={`toast ${notice.ok ? "ok" : "err"}`}>{notice.ok ? "✓ " : "⛔ "}{notice.text}</div>
        {/each}
      </div>
    {/if}

    <section class="metrics">
      <article><span>当前轨道</span><b>{activeTrack?.name}</b></article>
      <article><span>字幕条数</span><b>{$activeCues.length}</b></article>
      <article><span>待审 / 失效</span><b>{$activeCues.filter((c) => c.status === "待审").length} / {$activeCues.filter((c) => c.status === "失效").length}</b></article>
      <article class:warning={$pendingCount >= $ledger.pendingCapacity}><span>待决阻塞 / 容量</span><b>{$pendingCount} / {$ledger.pendingCapacity}</b></article>
    </section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head">
          <div><h2>时间轴（含修订号）</h2><small>rN 为当前修订；失效字幕由术语改译引起</small></div>
          <button class="btn variant-filled-primary" onclick={() => saveSnapshot()}>⌘S 冻结交付快照</button>
        </div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p>{#if cue.invalidatedBy}<small class="invalid-tag">由术语「{cue.invalidatedBy.termSource}」r{cue.invalidatedBy.fromRevision}→r{cue.invalidatedBy.toRevision} 作废</small>{/if}</div>
                <span class={`chip ${cue.status}`}>{cue.status} · r{cue.revision}</span>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
              </div>
            {/each}
          </div>
        {/if}
        {#if staleList.length}
          <div class="stale-banner"><b>被旧术语拖住的字幕：</b>{staleList.map((s) => s.cue.id).join("、")}（术语已升版，引用未跟进）</div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if $selectedCue}<span class={`chip ${$selectedCue.status}`}>{$selectedCue.status} · r{$selectedCue.revision}</span>{/if}</div>
          {#if $selectedCue}
            <div class="lock-line">
              {#if $selectedCue.lock}
                <span class="chip 待审">占住：{$selectedCue.lock.deviceId}（基于 r{$selectedCue.lock.baseRevision}，{new Date($selectedCue.lock.since).toLocaleTimeString("zh-CN")}）</span>
              {:else}<span class="chip">无审校占用</span>{/if}
            </div>
            <label class="label"><span>原文字幕</span><input class="input" value={$selectedCue.source} oninput={(event) => updateCue($selectedCue!.id, { source: event.currentTarget.value }, { baseRevision: $selectedCue!.revision })} /></label>
            <label class="label"><span>译文</span><textarea class="textarea" value={$selectedCue.translated} oninput={(event) => updateCue($selectedCue!.id, { translated: event.currentTarget.value }, { baseRevision: $selectedCue!.revision })}></textarea></label>
            <div class="time-fields">
              <label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={$selectedCue.start} oninput={(event) => updateCue($selectedCue!.id, { start: Number(event.currentTarget.value) }, { baseRevision: $selectedCue!.revision })} /></label>
              <label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={$selectedCue.end} oninput={(event) => updateCue($selectedCue!.id, { end: Number(event.currentTarget.value) }, { baseRevision: $selectedCue!.revision })} /></label>
            </div>
            <div class="actions">
              <button class="btn" onclick={() => submitForReview($selectedCue!.id)}>提交审校（占住）</button>
              <button class="btn variant-filled-success" onclick={() => reviewSelected($selectedCue!.id, true)}>审校通过</button>
              <button class="btn variant-filled-error" onclick={() => reviewSelected($selectedCue!.id, false, reviewNote || "请核对术语和断句")}>退回修改</button>
              {#if $selectedCue.status === "失效"}<button class="btn variant-filled-primary" onclick={() => rebaseCue($selectedCue!.id)}>按新术语重进审校</button>{/if}
            </div>
            <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因（冻结期也允许加备注）" /></label>

            <div class="refs">
              <b>术语引用（钉修订号）</b>
              <div class="ref-row">
                <select class="input" id="term-pick">
                  {#each $terms as term}<option value={term.id}>{term.source} → {term.target}（r{term.revision}）</option>{/each}
                </select>
                <button class="btn btn-sm" onclick={() => { const pick = document.getElementById("term-pick") as HTMLSelectElement; attachTerm($selectedCue!.id, pick.value); }}>引用术语当前修订</button>
              </div>
              {#each $selectedCue.termRefs as ref}
                {@const term = termById($ledger, ref.termId)}
                <div class="term-ref" class:stale={term && term.revision > ref.termRevision}>
                  {term?.source ?? ref.termId} @ r{ref.termRevision}{#if term && term.revision > ref.termRevision} ← 已落后（当前 r{term.revision}）{:else} ✓ 最新{/if}
                </div>
              {/each}
            </div>
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>阻塞项（冲突 / 作废）</h2><small>累计到容量上限会拒发整批</small></div>
          {#each $selectedBlockers as blocker}
            <article class={`conflict ${blocker.status}`}>
              <b>[{blocker.kind === "submit-conflict" ? "并发冲突" : "术语作废"}] {blocker.message}</b>
              <p>设备 {blocker.deviceId ?? "—"} · 基础版本 r{blocker.baseRevision ?? "—"} · {new Date(blocker.time).toLocaleTimeString("zh-CN")} · {blocker.status}</p>
              {#if blocker.status === "待处理"}
                <div class="actions">
                  {#if blocker.kind === "submit-conflict"}
                    <button class="btn btn-sm variant-filled-primary" onclick={() => settleBlocker(blocker.id, "resubmit")}>基于最新版重提</button>
                    <button class="btn btn-sm" onclick={() => settleBlocker(blocker.id, "withdraw")}>撤回我的提交</button>
                  {:else}
                    <button class="btn btn-sm variant-filled-primary" onclick={() => rebaseCue(blocker.cueId)}>按新术语修订并重进审校</button>
                  {/if}
                </div>
              {/if}
            </article>
          {/each}
          {#if !$selectedBlockers.length}<p class="muted">当前字幕没有阻塞项。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语库（改译即连锁失效）</h2><small>改译文回车 → 引用旧版的待审字幕立即失效重进审校</small></div>
          {#each $terms as term}
            <div class="term-edit">
              <div><b>{term.source}</b> <span class="muted">r{term.revision} · {term.status}</span></div>
              <div class="ref-row">
                <input class="input" placeholder="目标译法" value={termDraftTarget[term.id] ?? term.target} oninput={(e) => (termDraftTarget[term.id] = e.currentTarget.value)} onkeydown={(e) => { if (e.key === "Enter") { changeTerm(term.id, { target: (e.currentTarget as HTMLInputElement).value }); } }} />
                <button class="btn btn-sm variant-filled-primary" onclick={() => changeTerm(term.id, { target: termDraftTarget[term.id] ?? term.target })}>改译升版</button>
                <button class="btn btn-sm" disabled={term.status === "已锁定"} onclick={() => changeTerm(term.id, { status: "已锁定" })}>锁定</button>
              </div>
            </div>
          {/each}
        </section>
      </aside>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head"><h2>审校规则（随快照冻结）</h2></div>
        {#each $rules as rule}
          <label class="label"><span>{rule.title} · r{rule.revision}{rule.locale !== "*" ? ` · ${rule.locale}` : ""}</span><textarea class="textarea" value={rule.body} onchange={(e) => editRuleBody(rule, e.currentTarget.value)}></textarea></label>
        {/each}
      </section>

      <section class="panel">
        <div class="panel-head"><h2>修订账（最近 {Math.min($ledgerEntries.length, 40)} 笔）</h2><small>设备 · 基础版本 → 新修订 · 字段 · 触发源</small></div>
        <div class="events ledger">
          {#each $ledgerEntries.slice(0, 40) as entry}
            <article>
              <b>#{entry.seq} {entry.action}{entry.rejected ? "（被拒）" : ""}</b>
              <p class="ledger-line">
                <span class="mono">{entry.entityKind}:{entry.entityId}</span>
                <span class={`chip ${entry.rejected ? "退回" : "已通过"}`}>r{entry.baseRevision}→r{entry.newRevision}</span>
                <span class="chip">{entry.deviceId}</span>
                {#if entry.causedBy}<span class="chip 待审">由 {entry.causedBy} 引起</span>{/if}
              </p>
              {#each entry.fields as f}<p class="muted field-diff">{String(f.field)}: {JSON.stringify(f.before)} → {JSON.stringify(f.after)}</p>{/each}
              {#if entry.rejected}<p class="reject-text">{entry.rejected}</p>{/if}
              <small>{entry.locale} · {new Date(entry.time).toLocaleString("zh-CN")}</small>
            </article>
          {/each}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>交付快照与导出</h2><small>冻结字幕/术语/规则；导出失败保留已完成语言</small></div>
        <div class="events">
          {#each $snapshots as snapshot}
            {@const drift = driftFor(snapshot.id)}
            <article class="snapshot-card">
              <b>{snapshot.name}</b>
              <p>{new Date(snapshot.time).toLocaleString("zh-CN")} · {Object.keys(snapshot.frozen).length} 种语言冻结</p>
              <div class="export-grid">
                {#each Object.entries(snapshot.exportStatus) as [locale, status]}
                  <span class={`chip export ${status}`}>{locale}: {status}</span>
                {/each}
              </div>
              {#if snapshot.exportError}<p class="reject-text">{snapshot.exportError}</p>{/if}
              {#if drift.cues.length + drift.terms.length + drift.rules.length}
                <p class="muted">冻结后漂移：字幕 {drift.cues.length} · 术语 {drift.terms.length} · 规则 {drift.rules.length}（冻结结论不被覆盖）</p>
              {/if}
              <div class="ref-row">
                <select class="input" bind:value={exportFailLocale}>
                  <option value="">本次全部成功</option>
                  {#each Object.keys(snapshot.exportStatus) as loc}<option value={loc}>模拟 {loc} 导出失败</option>{/each}
                </select>
                <button class="btn btn-sm variant-filled-primary" onclick={() => publishSnapshot(snapshot.id, exportFailLocale ? [exportFailLocale] : [])}>
                  {Object.values(snapshot.exportStatus).some((s) => s === "已完成") ? "只补未完成语言" : "整批发布"}
                </button>
              </div>
            </article>
          {/each}
          {#if !$snapshots.length}<p>尚无快照，⌘S 冻结一版交付。</p>{/if}
        </div>
      </section>
    </div>

    <div class="bottom-grid second">
      <section class="panel">
        <div class="panel-head"><h2>新增字幕</h2></div>
        <form class="cue-form" method="POST" use:enhance>
          <label class="label"><span>原文</span><input class="input" name="source" bind:value={$form.source} /><small>{$errors.source?.[0]}</small></label>
          <label class="label"><span>译文</span><input class="input" name="translated" bind:value={$form.translated} /><small>{$errors.translated?.[0]}</small></label>
          <label class="label"><span>开始秒</span><input class="input" name="start" type="number" step="0.1" bind:value={$form.start} /></label>
          <label class="label"><span>持续秒</span><input class="input" name="duration" type="number" step="0.1" bind:value={$form.duration} /></label>
          <button class="btn variant-filled-primary" type="submit">新增到当前轨道（r1 起账）</button>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>全量阻塞项</h2></div>
        <div class="events">
          {#each $allBlockers as blocker}
            <article><b>[{blocker.kind === "submit-conflict" ? "冲突" : "作废"}] {blocker.status}</b><p>{blocker.message}</p><small>{blocker.locale} · {blocker.cueId}</small></article>
          {/each}
          {#if !$allBlockers.length}<p class="muted">没有阻塞项。</p>{/if}
        </div>
      </section>
    </div>
  </main>
</div>
