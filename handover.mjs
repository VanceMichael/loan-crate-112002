// 对外入口：采集三处来源，归并成账本，按箱/按作品给出交接视图。
//
//   const handover = await loadHandover({ url });
//   handover.crate('SE05', { site: '谷馆' })             // 按箱看当前操作范围
//   handover.work('W-J', { site: '谷馆' })               // 按作品看齐套缺失
//   handover.slot('SE05', { site: '谷馆', at: '12:05' }) // 排期前检查
//   handover.handoffPlan('SE05', { site: '谷馆' })       // 交接同事的作业单

import { collectAll } from './collect.mjs';
import { buildLedger, currentCrates } from './ledger.mjs';
import {
  crateScopeByPart,
  crateView,
  slotReadiness,
  timeValue,
  workReadiness,
  workShortage,
} from './evaluate.mjs';

export { collectAll, collectSource } from './collect.mjs';
export { buildLedger, currentCrates, lineageOf, timeValue } from './ledger.mjs';
export * from './evaluate.mjs';

function normalizeOptions(options = {}) {
  return { ...options, at: options.at === undefined || options.at === null ? null : timeValue(options.at) };
}

export async function loadHandover({ url, pageSize = 2 } = {}) {
  if (!url) throw new Error('需要来源地址');
  const data = await collectAll(url, { pageSize });
  const ledger = buildLedger(data.records);
  const log = { issues: ledger.issues, stages: data.stages, records: data.records.length };

  return {
    ledger,
    log,
    crates: () => currentCrates(ledger).map((parcel) => parcel.caseSeal),
    crate: (caseSeal, options) => crateView(ledger, caseSeal, normalizeOptions(options)),
    work: (workId, options) => workShortage(ledger, workId, normalizeOptions(options)),
    readiness: (workId, options) => workReadiness(ledger, workId, normalizeOptions(options)),
    slot: (caseSeal, options) => slotReadiness(ledger, caseSeal, normalizeOptions(options)),
    byPart: (parts) => crateScopeByPart(ledger, parts),
    // 交接作业单：一箱一行，列出每件在本站能做什么、卡在哪
    handoffPlan: (caseSeal, options) => {
      const opts = normalizeOptions(options);
      const view = crateView(ledger, caseSeal, opts);
      const slot = slotReadiness(ledger, caseSeal, { site: opts.site ?? view.site, at: opts.at ?? ledger.maxAt });
      return {
        caseSeal,
        site: opts.site ?? view.site,
        at: opts.at ?? ledger.maxAt,
        version: view.version,
        mode: view.mode,
        current: view.current,
        lineage: view.lineage,
        sealed: view.arrival.intact,
        arrived: view.arrival.arrived,
        holdWholeCrate: view.holdWholeCrate,
        holdReasons: view.holdReasons,
        schedulable: slot.ready,
        scheduleReasons: slot.reasons,
        parts: view.operations.map((entry) => ({
          part: entry.part,
          operations: Object.fromEntries(
            Object.entries(entry.operations).map(([name, detail]) => [
              name,
              { permitted: detail.permitted, ids: detail.ids, manifest: detail.manifest },
            ]),
          ),
          verified: entry.verified,
          verifiedAt: entry.verifiedAt,
          closedInner: entry.closedInner,
          verificationUnknown: entry.verificationUnknown,
          unprovableSince: entry.unprovableSince,
          holds: entry.holds,
        })),
      };
    },
  };
}
