// 记录归并：把三处来源的原始记录整理成可查询的业务账本。
// 这一层只做结构校验、版本链解析与索引，不做许可/交付裁决。
// 裁决集中在 evaluate.mjs，便于单独测试每条业务规则。

export const SOURCE_OF_KIND = {
  packing: 'carrier',
  arrival: 'carrier',
  repack: 'carrier',
  manifest: 'carrier',
  work: 'origin',
  permit: 'origin',
  presence: 'origin',
  revoke: 'origin',
  handoff: 'vault',
  slot: 'vault',
  open: 'vault',
  inspect: 'vault',
  sealed: 'vault',
  photo: 'vault',
};

export const PARCEL_MODES = new Set(['封箱', '换外箱', '重新分装']);

export function timeValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value));
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed / 60000;
}

const unique = (values) => [...new Set(values)];
const sameSet = (left = [], right = []) => {
  const a = unique(left).sort();
  const b = unique(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

function normalizeRecord(entry, index) {
  const kind = entry.kind;
  const source = entry.source ?? SOURCE_OF_KIND[kind] ?? 'unknown';
  const payload = entry.payload ?? entry;
  return {
    source,
    record: entry.record ?? `${source}-${index + 1}`,
    availableFrom: entry.availableFrom ?? 1,
    seenAtStage: entry.seenAtStage ?? entry.availableFrom ?? 1,
    kind,
    payload,
  };
}

function normalizeParcel(entry) {
  const { payload } = entry;
  const time = payload.time ?? null;
  return {
    ...entry,
    caseSeal: payload.caseSeal,
    parent: payload.parent ?? null,
    route: payload.route ?? null,
    site: payload.site ?? null,
    version: payload.version ?? 1,
    mode: entry.kind === 'packing' ? '封箱' : (payload.mode ?? '未知'),
    partsRaw: Array.isArray(payload.parts) ? unique(payload.parts) : null,
    innerRaw: payload.inner && typeof payload.inner === 'object' ? { ...payload.inner } : null,
    time,
    at: timeValue(time),
    parts: [],
    inner: {},
    contents: [],
    depth: 0,
    parentParcel: null,
  };
}

// 解析封条版本链。换外箱不改内容，重新分装可以改内容，两者含义不同。
function resolveParcels(parcels, issues) {
  const bySeal = new Map();
  for (const parcel of parcels) {
    if (!parcel.caseSeal) {
      issues.push({ code: 'seal-missing', record: parcel.record });
      continue;
    }
    if (bySeal.has(parcel.caseSeal)) {
      issues.push({ code: 'seal-duplicated', record: parcel.record, caseSeal: parcel.caseSeal });
      continue;
    }
    bySeal.set(parcel.caseSeal, parcel);
  }
  const resolving = new Set();
  const resolved = new Set();
  const visit = (parcel) => {
    if (!parcel || resolved.has(parcel.caseSeal)) return parcel;
    if (resolving.has(parcel.caseSeal)) {
      issues.push({ code: 'seal-cycle', record: parcel.record, caseSeal: parcel.caseSeal });
      return parcel;
    }
    resolving.add(parcel.caseSeal);

    const parent = parcel.parent ? bySeal.get(parcel.parent) : null;
    if (parcel.parent && !parent) {
      issues.push({ code: 'parent-missing', record: parcel.record, caseSeal: parcel.caseSeal, parent: parcel.parent });
    }
    if (parent) visit(parent);

    if (!parent) {
      if (parcel.kind === 'repack') {
        issues.push({ code: 'repack-without-parent', record: parcel.record, caseSeal: parcel.caseSeal });
      }
      parcel.parts = unique(parcel.partsRaw ?? []);
      parcel.inner = { ...(parcel.innerRaw ?? {}) };
    } else if (parcel.mode === '换外箱') {
      // 只换外箱：内容应当不变，原内盒映射原样带过来
      parcel.parts = unique(parcel.partsRaw ?? parent.parts);
      if (parcel.partsRaw && !sameSet(parcel.partsRaw, parent.parts)) {
        issues.push({
          code: 'outer-swap-changed-parts',
          record: parcel.record,
          caseSeal: parcel.caseSeal,
          parent: parent.caseSeal,
          reason: '换外箱记录的部件与原箱不一致；换外箱不应改变内容',
        });
      }
      parcel.inner = { ...parent.inner, ...(parcel.innerRaw ?? {}) };
    } else if (parcel.mode === '重新分装') {
      // 重新分装：内容可以改变，必须给出新清单
      if (parcel.partsRaw === null) {
        issues.push({ code: 'repack-parts-missing', record: parcel.record, caseSeal: parcel.caseSeal });
      }
      parcel.parts = unique(parcel.partsRaw ?? []);
      parcel.inner = { ...(parcel.innerRaw ?? {}) };
      // 上一代声明在封闭内盒里的件，新清单必须交代去向；否则无法确认是否随箱移动
      const unaccounted = Object.keys(parent.inner).filter(
        (part) => !parcel.parts.includes(part) && !parcel.inner[part],
      );
      if (unaccounted.length > 0) {
        issues.push({
          code: 'inner-unaccounted',
          record: parcel.record,
          caseSeal: parcel.caseSeal,
          parent: parent.caseSeal,
          parts: unaccounted,
          reason: '重新分装的清单没有交代原内盒里的件，无法确认是否随箱移动',
        });
      }
    } else {
      issues.push({
        code: 'repack-mode-unknown',
        record: parcel.record,
        caseSeal: parcel.caseSeal,
        mode: parcel.mode,
        known: [...PARCEL_MODES],
      });
      parcel.parts = unique(parcel.partsRaw ?? parent.parts);
      parcel.inner = { ...parent.inner, ...(parcel.innerRaw ?? {}) };
    }
    // 内盒里的件随箱移动，即使未列在外层 parts 里也属于箱内容
    parcel.contents = unique([...parcel.parts, ...Object.keys(parcel.inner)]);

    if (parent) {
      if (!(parcel.version > parent.version)) {
        issues.push({
          code: 'version-not-increasing',
          record: parcel.record,
          caseSeal: parcel.caseSeal,
          version: parcel.version,
          parentVersion: parent.version,
        });
      }
      parcel.depth = (parent.depth ?? 0) + 1;
    } else {
      parcel.depth = 0;
    }
    parcel.parentParcel = parent ?? null;
    resolving.delete(parcel.caseSeal);
    resolved.add(parcel.caseSeal);
    return parcel;
  };
  for (const parcel of bySeal.values()) visit(parcel);

  const children = new Map();
  for (const parcel of bySeal.values()) {
    if (!parcel.parentParcel) continue;
    const list = children.get(parcel.parentParcel.caseSeal) ?? [];
    list.push(parcel);
    children.set(parcel.parentParcel.caseSeal, list);
  }
  for (const list of children.values()) list.sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
  return { bySeal, children };
}

export function lineageOf(ledger, caseSeal) {
  const result = [];
  let current = ledger.parcelBySeal.get(caseSeal);
  const seen = new Set();
  while (current && !seen.has(current.caseSeal)) {
    result.push(current);
    seen.add(current.caseSeal);
    current = current.parentParcel;
  }
  return result;
}

export function buildLedger(records) {
  const normalized = records.map(normalizeRecord);
  const issues = [];
  const ledger = {
    records: normalized,
    issues,
    parcels: [],
    parcelBySeal: new Map(),
    childrenByParent: new Map(),
    arrivals: [],
    works: [],
    permits: [],
    presences: [],
    revokes: [],
    handoffs: [],
    slots: [],
    opens: [],
    inspects: [],
    seals: [],
    photos: [],
    manifests: [],
    unknown: [],
    maxAt: null,
    minAt: null,
  };

  for (const entry of normalized) {
    const { payload, kind } = entry;
    switch (kind) {
      case 'packing':
      case 'repack':
        ledger.parcels.push(normalizeParcel(entry));
        break;
      case 'arrival':
        ledger.arrivals.push({
          ...entry,
          caseSeal: payload.caseSeal,
          site: payload.site ?? null,
          time: payload.time ?? null,
          at: timeValue(payload.time),
          seal: payload.seal ?? null,
        });
        break;
      case 'manifest':
        ledger.manifests.push({
          ...entry,
          caseSeal: payload.caseSeal,
          version: payload.version ?? null,
          parts: unique(payload.parts ?? []),
          inner: { ...(payload.inner ?? {}) },
          time: payload.time ?? null,
          at: timeValue(payload.time),
          site: payload.site ?? null,
        });
        break;
      case 'work':
        ledger.works.push({
          ...entry,
          workId: payload.workId ?? payload.id,
          parts: unique(payload.parts ?? payload.requiredParts ?? []),
        });
        break;
      case 'permit':
        ledger.permits.push({
          ...entry,
          id: payload.permit ?? payload.id ?? entry.record,
          site: payload.site,
          parts: unique(payload.parts ?? []),
          scope: unique(payload.scope ?? []),
          closedTransfer: unique(payload.closedTransfer ?? []),
          workId: payload.workId ?? null,
          seal: payload.seal ?? payload.caseSeal ?? null,
          manifest: payload.manifest ?? payload.version ?? null,
          from: payload.from ?? null,
          to: payload.to ?? null,
          fromAt: timeValue(payload.from),
          toAt: timeValue(payload.to),
          revokedAt: null,
        });
        break;
      case 'presence':
        ledger.presences.push({
          ...entry,
          id: payload.presence ?? payload.id ?? entry.record,
          permit: payload.permit ?? null,
          site: payload.site,
          caseSeal: payload.caseSeal ?? payload.seal ?? null,
          manifest: payload.manifest ?? payload.version ?? null,
          parts: payload.parts ? unique(payload.parts) : null,
          operations: unique(payload.operations ?? payload.scope ?? []),
          closedTransfer: unique(payload.closedTransfer ?? []),
          from: payload.from ?? null,
          to: payload.to ?? null,
          fromAt: timeValue(payload.from),
          toAt: timeValue(payload.to),
        });
        break;
      case 'revoke':
        ledger.revokes.push({
          ...entry,
          permit: payload.permit ?? payload.id,
          time: payload.time ?? null,
          at: timeValue(payload.time),
        });
        break;
      case 'handoff':
        ledger.handoffs.push({
          ...entry,
          receipt: payload.receipt,
          caseSeal: payload.caseSeal,
          manifest: payload.manifest ?? payload.version ?? null,
          site: payload.site ?? null,
          time: payload.time ?? null,
          at: timeValue(payload.time),
          custodian: payload.custodian ?? null,
        });
        break;
      case 'slot':
        ledger.slots.push({
          ...entry,
          id: payload.slot ?? payload.id ?? entry.record,
          site: payload.site,
          caseSeal: payload.caseSeal ?? null,
          operator: payload.operator ?? payload.by ?? null,
          from: payload.from ?? null,
          to: payload.to ?? null,
          fromAt: timeValue(payload.from),
          toAt: timeValue(payload.to),
          parts: payload.parts ? unique(payload.parts) : null,
        });
        break;
      case 'open':
        ledger.opens.push({
          ...entry,
          receipt: payload.receipt ?? null,
          caseSeal: payload.caseSeal,
          site: payload.site ?? null,
          time: payload.time ?? null,
          at: timeValue(payload.time),
          outer: {
            sealBreak: payload.outer?.sealBreak !== false,
            part: payload.outer?.part ?? payload.part ?? null,
            parts: payload.outer?.parts ? unique(payload.outer.parts) : null,
            operations: unique(payload.outer?.operations ?? payload.operations ?? []),
            photo: payload.outer?.photo ?? payload.photo ?? null,
            box: payload.outer?.box ?? null,
          },
          inner: payload.inner
            ? {
                box: payload.inner.box ?? null,
                opened: payload.inner.opened === true,
                parts: payload.inner.parts ? unique(payload.inner.parts) : null,
                operations: unique(payload.inner.operations ?? []),
                photo: payload.inner.photo ?? null,
              }
            : null,
          receiptRef: payload.handoff ?? null,
          manifest: payload.manifest ?? payload.version ?? null,
          custodian: payload.custodian ?? payload.by ?? null,
          approvedBy: payload.approvedBy ?? null,
        });
        break;
      case 'inspect':
        ledger.inspects.push({
          ...entry,
          receipt: payload.receipt,
          caseSeal: payload.caseSeal,
          part: payload.part ?? payload.outer?.part ?? null,
          site: payload.site ?? null,
          time: payload.time ?? null,
          at: timeValue(payload.time),
          photo: payload.photo ?? null,
          open: payload.open ?? payload.receiptOfOpen ?? null,
          manifest: payload.manifest ?? payload.version ?? null,
          condition: payload.condition ?? null,
        });
        break;
      case 'sealed':
        ledger.seals.push({
          ...entry,
          caseSeal: payload.caseSeal,
          site: payload.site ?? null,
          time: payload.time ?? null,
          at: timeValue(payload.time),
          by: payload.by ?? payload.operator ?? null,
          receipt: payload.receipt ?? null,
          newSeal: payload.newSeal ?? payload.seal ?? null,
        });
        break;
      case 'photo':
        ledger.photos.push({
          ...entry,
          id: payload.photo ?? payload.id ?? entry.record,
          part: payload.part ?? null,
          caseSeal: payload.caseSeal ?? null,
          at: timeValue(payload.time),
        });
        break;
      default:
        ledger.unknown.push(entry);
        issues.push({ code: 'unknown-kind', record: entry.record, kind });
        break;
    }
  }

  const { bySeal, children } = resolveParcels(ledger.parcels, issues);
  ledger.parcelBySeal = bySeal;
  ledger.childrenByParent = children;

  // 改表不等于改吊牌：同一封条下另发的运输清单只更新纸面，不构成新的封箱事实。
  // 清单内容与吊牌不一致时，超出封箱清单的部分要重新核对，不能算作封箱时已确认。
  for (const manifest of ledger.manifests) {
    const parcel = bySeal.get(manifest.caseSeal);
    if (!parcel) {
      issues.push({ code: 'manifest-without-seal', record: manifest.record, caseSeal: manifest.caseSeal });
      continue;
    }
    const changedParts = unique([...manifest.parts, ...parcel.parts]).filter(
      (part) => !manifest.parts.includes(part) || !parcel.parts.includes(part),
    );
    if (changedParts.length > 0) {
      issues.push({
        code: 'manifest-drift-without-reseal',
        record: manifest.record,
        caseSeal: manifest.caseSeal,
        version: manifest.version ?? parcel.version,
        parts: changedParts,
        reason: '运输清单变了但吊牌未换，超出封箱清单的部件需要重新核对',
      });
    }
    manifest.sealedParts = [...parcel.parts];
    manifest.driftParts = changedParts;
  }

  for (const permit of ledger.permits) {
    const revoked = ledger.revokes
      .filter((entry) => entry.permit === permit.id || entry.permit === permit.record)
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))[0];
    permit.revokedAt = revoked ? revoked.at : null;
  }

  const timed = [
    ...ledger.parcels,
    ...ledger.arrivals,
    ...ledger.handoffs,
    ...ledger.opens,
    ...ledger.inspects,
    ...ledger.seals,
    ...ledger.manifests,
    ...ledger.slots,
    ...ledger.presences,
  ].filter((entry) => entry.at !== null && entry.at !== undefined);
  if (timed.length > 0) {
    ledger.maxAt = Math.max(...timed.map((entry) => entry.at));
    ledger.minAt = Math.min(...timed.map((entry) => entry.at));
  }

  for (const list of [
    ledger.parcels,
    ledger.arrivals,
    ledger.handoffs,
    ledger.opens,
    ledger.inspects,
    ledger.seals,
    ledger.manifests,
    ledger.slots,
    ledger.presences,
  ]) {
    list.sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
  }

  return ledger;
}

export function currentCrates(ledger) {
  return [...ledger.parcelBySeal.values()].filter((parcel) => !(ledger.childrenByParent.get(parcel.caseSeal)?.length));
}

export function parcelAt(ledger, caseSeal) {
  return ledger.parcelBySeal.get(caseSeal) ?? null;
}
