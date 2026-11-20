// 裁决层：箱级可做什么、部件是否已确证、作品能否交给布展。
//
// 三条互相独立的轴，任何一条断了都不能算“这件作品已经查齐”：
// 1. 物证（custody）：箱在现场、封条核对过、开封有当时授权、开完有人接手封存。
// 2. 许可（authority）：出借许可按 作品部件 × 场馆 × 操作 生效；现场在场许可只补充时段，
//    不能把许可的部件范围放大。
// 3. 可证明性（provability）：沿封条链回溯，每一代换箱都有与其清单版本一致的签收。
//
// 时间一律用业务时间（记录里的 time），不用记录到达回放的先后。分箱更正晚到，
// 不会把已经按旧清单发生的事实抹掉，也不会让下一馆已完成的实物点验失效；
// 超出当时授权范围的部分另行挂起。

import { timeValue } from './ledger.mjs';

const unique = (values) => [...new Set(values)];
const has = (list, value) => Array.isArray(list) && list.includes(value);
const atOrAfter = (left, right) => right === null || right === undefined || left === null || left === undefined || left >= right;
const atOrBefore = (left, right) => right === null || right === undefined || left === null || left === undefined || left <= right;
const before = (left, right) =>
  left !== null && left !== undefined && right !== null && right !== undefined && left < right;
const within = (at, fromAt, toAt) => at !== null && at !== undefined && atOrAfter(at, fromAt) && atOrBefore(at, toAt);

const gap = (reason, detail = {}) => ({ reason, ...detail });
const sealLabel = (parcel) =>
  `${parcel.site ?? '未知场馆'} ${parcel.caseSeal}（清单版 ${parcel.version}）`;

// ---------------------------------------------------------------------------
// 许可
// ---------------------------------------------------------------------------

export function permitApplies(permit, { site, part, operation, at = null, caseSeal = null, manifest = null }) {
  if (permit.site !== site) return false;
  if (!has(permit.parts, part)) return false;
  if (!has(permit.scope, operation)) return false;
  // 许可写明了封条/清单版本时，只对那一代有效；现场换了箱或换了表，不能沿用
  if (permit.seal && caseSeal && permit.seal !== caseSeal) return false;
  if (
    permit.manifest !== null &&
    permit.manifest !== undefined &&
    manifest !== null &&
    manifest !== undefined &&
    permit.manifest !== manifest
  ) {
    return false;
  }
  // 到期/撤销后，已领用的许可不再对之后的操作生效
  if (permit.revokedAt !== null && permit.revokedAt !== undefined) {
    if (at === null || at === undefined || at > permit.revokedAt) return false;
  }
  return atOrAfter(at, permit.fromAt) && atOrBefore(at, permit.toAt);
}

export function presenceApplies(presence, { site, part, operation, at, caseSeal, manifest }) {
  if (presence.site !== site) return false;
  if (!has(presence.operations, operation)) return false;
  if (presence.parts && !has(presence.parts, part)) return false;
  if (presence.caseSeal && caseSeal && presence.caseSeal !== caseSeal) return false;
  if (presence.manifest !== null && presence.manifest !== undefined && manifest !== null && presence.manifest !== manifest) {
    return false;
  }
  return within(at, presence.fromAt, presence.toAt);
}

// 某馆在某时、对某部件执行某操作的全部依据。
export function authorityFor(ledger, { site, part, operation, at = null, caseSeal = null, manifest = null }) {
  if (!site || !part) return { permits: [], presences: [], allowed: false, ids: [] };
  const permits = ledger.permits.filter((permit) => permitApplies(permit, { site, part, operation, at, caseSeal, manifest }));
  const presences = ledger.presences.filter((presence) =>
    presenceApplies(presence, { site, part, operation, at, caseSeal, manifest }),
  );
  return {
    permits,
    presences,
    allowed: permits.length > 0 || presences.length > 0,
    ids: [...permits.map((entry) => entry.id), ...presences.map((entry) => entry.id)],
  };
}

// 一张许可对某只箱、某版清单是否还能用：
// 已领用的许可只对现场确证的封条和当前点验清单有效。
export function permitUsableForCrate(permit, parcel) {
  const gaps = [];
  if (permit.seal && permit.seal !== parcel.caseSeal) {
    gaps.push(`许可指向封条 ${permit.seal}，不是当前封条 ${parcel.caseSeal}`);
  }
  if (permit.manifest !== null && permit.manifest !== undefined && permit.manifest !== parcel.version) {
    gaps.push(`许可指向清单版 ${permit.manifest}，当前为 ${parcel.version}`);
  }
  return { usable: gaps.length === 0, gaps };
}

// ---------------------------------------------------------------------------
// 箱的物证：现场、封条、开封、封存
// ---------------------------------------------------------------------------

export function arrivalsFor(ledger, caseSeal) {
  return ledger.arrivals
    .filter((entry) => entry.caseSeal === caseSeal)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

// 封条断开的全部事实：馆方现场开封 + 承运端换箱（换箱必然断开上一代封条）。
// 两者含义不同：前者是馆方动作，后者是承运端的封条过渡；但都使旧封条不再完整。
export function sealBreaks(ledger, caseSeal) {
  const explicit = ledger.opens
    .filter((entry) => entry.caseSeal === caseSeal && entry.outer.sealBreak)
    .map((entry) => ({ kind: 'open', at: entry.at, site: entry.site, time: entry.time, record: entry.record, open: entry }));
  const transitions = (ledger.childrenByParent.get(caseSeal) ?? []).map((child) => ({
    kind: 'repack',
    at: child.at,
    site: child.site,
    time: child.time,
    record: child.record,
    mode: child.mode,
    childSeal: child.caseSeal,
  }));
  return [...explicit, ...transitions].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

export function explicitOpens(ledger, caseSeal) {
  return ledger.opens
    .filter((entry) => entry.caseSeal === caseSeal)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

// 箱在 at 时是否在该馆现场：有到站记录，或是在该馆封箱/换箱的。
export function presenceFor(ledger, caseSeal, site, at = null) {
  const parcel = ledger.parcelBySeal.get(caseSeal) ?? null;
  if (!parcel) return { present: false, basis: null, since: null, arrival: null, sealedThere: false };
  const arrival =
    arrivalsFor(ledger, caseSeal)
      .filter((entry) => (!site || entry.site === site) && atOrBefore(entry.at, at))
      .at(-1) ?? null;
  const createdHere = parcel.site === site && parcel.at !== null && parcel.at !== undefined && atOrAfter(at, parcel.at);
  if (arrival) {
    return {
      present: true,
      basis: 'arrival',
      since: arrival.at,
      arrival,
      sealedThere: arrival.seal === '完整',
      site,
    };
  }
  if (createdHere) {
    return {
      present: true,
      basis: parcel.kind === 'repack' ? 'repacked-here' : 'packed-here',
      since: parcel.at,
      arrival: null,
      sealedThere: true,
      site,
    };
  }
  return { present: false, basis: null, since: null, arrival: null, sealedThere: false, site };
}

// 到站与封条状态（用于“箱到了”“封条核对失败”）。
export function arrivalState(ledger, caseSeal) {
  const history = arrivalsFor(ledger, caseSeal);
  const arrival = history.at(-1) ?? null;
  const parcel = ledger.parcelBySeal.get(caseSeal) ?? null;
  const created = Boolean(parcel && parcel.at !== null && parcel.at !== undefined);
  return {
    arrived: Boolean(arrival),
    intact: arrival ? arrival.seal === '完整' : created,
    arrival,
    history,
    sealedAtSource: !arrival && created ? parcel : null,
  };
}

// 封条在 at 之后是否仍可沿用封箱时的完整证明。
export function sealIntactAt(ledger, caseSeal, at = null) {
  const state = arrivalState(ledger, caseSeal);
  if (!state.intact) return false;
  if (at === null || at === undefined) {
    return sealBreaks(ledger, caseSeal).length === 0;
  }
  return !sealBreaks(ledger, caseSeal).some((entry) => before(at, entry.at));
}

// 一次馆方开封是否获准。开箱时许可必须已生效；若箱内还有未获准点验、又不在
// 封闭内盒放行范围内的部件，开箱会暴露它们，库房必须挂起整箱请求。
export function evaluateOpen(ledger, open) {
  const parcel = ledger.parcelBySeal.get(open.caseSeal) ?? null;
  const manifest = open.manifest ?? parcel?.version ?? null;
  const crateParts = parcel?.contents ?? [];
  const targets = open.outer.part ? [open.outer.part] : crateParts;
  const operations = open.outer.operations.length > 0 ? open.outer.operations : ['开封'];

  const targetsAllowed = targets.map((part) => ({
    part,
    allowed: operations.every(
      (operation) =>
        authorityFor(ledger, {
          site: open.site,
          part,
          operation,
          at: open.at,
          caseSeal: open.caseSeal,
          manifest,
        }).allowed,
    ),
  }));
  // 指定部件时按该部件核；箱级开封只要有一个部件获准即可发起，其余部件靠 exposure 判定挂起
  const outerAllowed = open.outer.part
    ? targetsAllowed.every((entry) => entry.allowed)
    : targetsAllowed.some((entry) => entry.allowed);

  const inspectionScope = crateParts.map((part) => {
    const authority = authorityFor(ledger, {
      site: open.site,
      part,
      operation: '点验',
      at: open.at,
      caseSeal: open.caseSeal,
      manifest,
    });
    return { part, allowed: authority.allowed, ids: authority.ids };
  });
  const allowedParts = inspectionScope.filter((entry) => entry.allowed).map((entry) => entry.part);
  // 出借方明确允许封闭内盒原样周转：盒内的件不因开外箱而暴露
  const closedTransfer = (part) => {
    const inner = parcel?.inner[part];
    if (!inner) return false;
    return ledger.permits.some((permit) => permit.site === open.site && has(permit.closedTransfer, inner));
  };
  const exposure = crateParts.filter((part) => !allowedParts.includes(part) && !closedTransfer(part));

  const gaps = [];
  if (!open.outer.sealBreak) gaps.push(gap('没有现场断封动作，不能证明外箱被打开', { stage: 'outer' }));
  if (!outerAllowed) gaps.push(gap('开封时没有覆盖该部件的开封许可或现场在场许可', { stage: 'outer' }));
  if (open.inner && open.inner.opened) {
    const innerParts = open.inner.parts ?? crateParts.filter((part) => parcel?.inner[part]);
    const innerAllowed = innerParts.every((part) => {
      if (!parcel) return false;
      return ledger.permits.some(
        (permit) =>
          permit.site === open.site &&
          has(permit.parts, part) &&
          (has(permit.closedTransfer, parcel.inner[part]) || has(permit.scope, '开封')),
      );
    });
    if (!innerAllowed) gaps.push(gap('内盒开封缺少覆盖内盒部件的许可或封闭内盒放行', { stage: 'inner' }));
  }

  return {
    open,
    parcel,
    crateParts,
    outerAllowed,
    innerOpened: Boolean(open.inner?.opened),
    inspectionScope,
    allowedParts,
    exposure,
    closedTransferParts: crateParts.filter(closedTransfer),
    // 只获准点验其中一件、开箱会暴露其他件：整箱开封请求挂起
    holdWholeCrate: allowedParts.length > 0 && exposure.length > 0,
    gaps,
    valid: gaps.length === 0,
  };
}

// 点验时箱是否已经在现场被打开过（馆方开封），或内容是否在该馆刚被重新分装过。
export function accessFor(ledger, caseSeal, site, at) {
  const opens = explicitOpens(ledger, caseSeal).filter(
    (entry) => (!site || entry.site === site) && atOrBefore(entry.at, at),
  );
  if (opens.length > 0) {
    return { hasAccess: true, basis: 'open', opens, open: opens.at(-1) };
  }
  const parcel = ledger.parcelBySeal.get(caseSeal);
  const created = (candidate) =>
    candidate &&
    candidate.site === site &&
    candidate.at !== null &&
    candidate.at !== undefined &&
    atOrAfter(at, candidate.at);
  if (created(parcel)) {
    return { hasAccess: true, basis: parcel.kind === 'repack' ? 'repacked-here' : 'packed-here', opens, open: null };
  }
  const parent = parcel?.parentParcel ?? null;
  if (created(parent)) {
    return { hasAccess: true, basis: 'parent-packed-here', opens, open: null };
  }
  return { hasAccess: false, basis: null, opens, open: null };
}

function findOpenForInspection(ledger, inspectEntry) {
  const opens = explicitOpens(ledger, inspectEntry.caseSeal);
  if (inspectEntry.open) {
    return opens.find((entry) => entry.receipt === inspectEntry.open || entry.record === inspectEntry.open) ?? null;
  }
  return (
    opens
      .filter(
        (entry) =>
          (!entry.site || !inspectEntry.site || entry.site === inspectEntry.site) &&
          atOrBefore(entry.at, inspectEntry.at),
      )
      .at(-1) ?? null
  );
}

// 一次点验是否可用：有效开封之后、许可覆盖该部件、凭据能对应到这件实物。
export function evaluateInspection(ledger, inspectEntry) {
  const gaps = [];
  const parcel = ledger.parcelBySeal.get(inspectEntry.caseSeal) ?? null;

  if (!inspectEntry.part) gaps.push(gap('点验记录没有写明部件'));
  if (!parcel) gaps.push(gap('点验对应的封条没有封箱记录'));
  else if (!parcel.contents.includes(inspectEntry.part)) {
    gaps.push(gap('该部件不在这只箱当前版本的分装清单内'));
  }

  const open = findOpenForInspection(ledger, inspectEntry);
  if (open) {
    const evaluatedOpen = evaluateOpen(ledger, open);
    for (const detail of evaluatedOpen.gaps) gaps.push(gap(`开封无效：${detail.reason}`, { stage: detail.stage }));
  }

  const access = accessFor(ledger, inspectEntry.caseSeal, inspectEntry.site, inspectEntry.at);
  if (!access.hasAccess) {
    gaps.push(gap('点验无法关联到现场开封或本馆分装事实，不能证明查验了实物'));
  }
  // 点验前如果有馆方开封，其中一次没有获准，这次点验不能假装没发生过；
  // 除非那次开封之后已经有具名的当场封存把 Custody 重新接上。
  const tainted = access.opens
    .filter((entry) => entry.at !== null && inspectEntry.at !== null && entry.at <= inspectEntry.at)
    .map((entry) => evaluateOpen(ledger, entry))
    .find((entry) => {
      if (entry.valid) return false;
      const resealed = ledger.seals.some(
        (seal) => seal.caseSeal === inspectEntry.caseSeal && seal.by && seal.at !== null && seal.at > entry.open.at && seal.at <= inspectEntry.at,
      );
      return !resealed;
    });
  if (tainted) {
    gaps.push(
      gap(
        `同箱此前有未获准且未重新封存的开封（${tainted.open.receipt ?? tainted.open.record}）`,
        { stage: 'custody' },
      ),
    );
  }

  const authority = authorityFor(ledger, {
    site: inspectEntry.site,
    part: inspectEntry.part,
    operation: '点验',
    at: inspectEntry.at,
    caseSeal: inspectEntry.caseSeal,
    manifest: inspectEntry.manifest,
  });
  if (!authority.allowed) gaps.push(gap('点验时没有覆盖该部件的点验许可或现场许可'));

  if (!inspectEntry.receipt) gaps.push(gap('点验没有回执编号，不能作为实物凭据'));
  if (inspectEntry.photo) {
    const photo = ledger.photos.find((entry) => entry.id === inspectEntry.photo);
    if (photo && photo.part && inspectEntry.part && photo.part !== inspectEntry.part) {
      gaps.push(gap('照片对应的实物不是本部件', { photo: photo.id }));
    }
    if (photo && photo.caseSeal && photo.caseSeal !== inspectEntry.caseSeal) {
      gaps.push(gap('照片来自另一只箱', { photo: photo.id }));
    }
    const reused = ledger.inspects.filter(
      (entry) => entry.photo === inspectEntry.photo && entry.part !== inspectEntry.part,
    );
    if (reused.length > 0) {
      gaps.push(gap('同一照片编号被用来证明不同部件', { photo: inspectEntry.photo }));
    }
  }

  return {
    inspect: inspectEntry,
    open,
    access,
    valid: gaps.length === 0,
    gaps,
    part: inspectEntry.part,
    // 开封凭据缺失但实物点验本身成立时，单独标出，供交接同事核对
    openingUnrecorded: access.hasAccess && !access.open,
  };
}

// 谁接手封存：某次开封之后、同馆同箱的封存记录
export function custodianAfter(ledger, caseSeal, site, at = null) {
  return (
    ledger.seals
      .filter(
        (entry) =>
          entry.caseSeal === caseSeal &&
          (!site || entry.site === site) &&
          atOrAfter(entry.at, at),
      )
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
      .at(-1) ?? null
  );
}

// ---------------------------------------------------------------------------
// 可证明性：每一次换箱都要有与自己清单版本一致的签收
// ---------------------------------------------------------------------------

export function handoffValidity(ledger, handoff) {
  const parcel = ledger.parcelBySeal.get(handoff.caseSeal);
  const gaps = [];
  if (!parcel) {
    gaps.push(gap('签收对应的封条没有封箱记录'));
    return { handoff, valid: false, gaps, parcel: null };
  }
  if (handoff.manifest !== null && handoff.manifest !== undefined && handoff.manifest !== parcel.version) {
    gaps.push(gap('签收的清单版本与该封条不符', { signed: handoff.manifest, actual: parcel.version }));
  }
  const arrival = arrivalsFor(ledger, handoff.caseSeal)
    .filter((entry) => atOrBefore(entry.at, handoff.at))
    .at(-1);
  if (!arrival) gaps.push(gap('签收之前没有该箱的到站记录'));
  else if (arrival.seal !== '完整') gaps.push(gap('签收时封条不完整'));
  // 封条一旦断开，就不能再沿用封箱时的完整证明来签收；
  // 除非断开之后已经有具名的当场封存记录把监管链重新接上。
  const brokenBefore = sealBreaks(ledger, handoff.caseSeal).filter(
    (entry) => entry.at !== null && handoff.at !== null && entry.at <= handoff.at,
  );
  const resealed = brokenBefore.some((entry) =>
    ledger.seals.some(
      (seal) =>
        seal.caseSeal === handoff.caseSeal &&
        seal.by &&
        seal.at !== null &&
        entry.at !== null &&
        seal.at >= entry.at &&
        handoff.at !== null &&
        seal.at <= handoff.at,
    ),
  );
  if (brokenBefore.length > 0 && !resealed) {
    gaps.push(
      gap(`签收前封条已在 ${brokenBefore[0].time ?? ''} 断开，封箱时的完整证明不能沿用`, {
        breakAt: brokenBefore[0].time,
        breakKind: brokenBefore[0].kind,
      }),
    );
  }
  return { handoff, valid: gaps.length === 0, gaps, parcel };
}

// 沿封条链回溯：哪一代起没有有效签收。上一馆的签收仍然保留、可查，
// 但不能用来证明换箱之后的内容。
export function provability(ledger, caseSeal) {
  const points = [];
  let cursor = ledger.parcelBySeal.get(caseSeal) ?? null;
  const seen = new Set();
  while (cursor && !seen.has(cursor.caseSeal)) {
    seen.add(cursor.caseSeal);
    const handoffs = ledger.handoffs
      .filter((entry) => entry.caseSeal === cursor.caseSeal)
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
      .map((entry) => handoffValidity(ledger, entry));
    const matching = handoffs.filter(
      (entry) =>
        entry.valid &&
        (entry.handoff.manifest === null ||
          entry.handoff.manifest === undefined ||
          entry.handoff.manifest === cursor.version),
    );
    points.push({
      parcel: cursor,
      handoffs,
      validHandoff: matching[0] ?? null,
      broken: matching.length === 0,
    });
    cursor = cursor.parentParcel;
  }

  // 换箱发生在上一代签收之前：新清单没有被任何交接确认过。
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point.broken || index === 0) continue;
    const prior = points[index - 1];
    if (prior.broken) continue;
    const newer = prior.parcel;
    const signedAt = prior.validHandoff?.handoff.at ?? null;
    if (newer.at !== null && newer.at !== undefined && signedAt !== null && signedAt !== undefined) {
      if (newer.at < signedAt) {
        point.broken = true;
        point.brokenReason = '换箱早于上一代签收，新清单没有经过交接确认';
      }
    }
  }

  const firstBroken = points.find((point) => point.broken) ?? null;
  const brokenHandoff = firstBroken?.handoffs.find((entry) => !entry.valid) ?? null;
  return {
    caseSeal,
    points,
    provable: firstBroken === null,
    unprovableSince: firstBroken
      ? {
          caseSeal: firstBroken.parcel.caseSeal,
          version: firstBroken.parcel.version,
          site: firstBroken.parcel.site,
          time: firstBroken.parcel.time,
          mode: firstBroken.parcel.mode,
          reason:
            firstBroken.brokenReason ??
            brokenHandoff?.gaps[0]?.reason ??
            '缺少与该版清单一致的签收',
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// 部件级状态
// ---------------------------------------------------------------------------

function crateHistory(ledger, part) {
  return [...ledger.parcelBySeal.values()]
    .filter((parcel) => parcel.contents.includes(part))
    .sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
}

// 部件在某只箱里的状态：只看这只箱自己的开封、点验与签收，不借用其他箱。
export function partStateInCrate(ledger, part, caseSeal) {
  const parcel = ledger.parcelBySeal.get(caseSeal) ?? null;
  const inspections = ledger.inspects
    .filter((entry) => entry.part === part && entry.caseSeal === caseSeal)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
    .map((entry) => evaluateInspection(ledger, entry));
  const valid = inspections.filter((entry) => entry.valid).at(-1) ?? null;
  const proof = parcel ? provability(ledger, caseSeal) : null;
  return {
    part,
    crate: parcel,
    inspectedHere: inspections.length > 0,
    inspections,
    validInspection: valid,
    latestInspection: inspections.at(-1) ?? null,
    verified: Boolean(valid),
    verifiedAt: valid
      ? {
          receipt: valid.inspect.receipt,
          site: valid.inspect.site,
          time: valid.inspect.time,
          photo: valid.inspect.photo,
          open: valid.open?.receipt ?? null,
          basis: valid.access.basis,
        }
      : null,
    provability: proof,
    unprovableSince: proof?.unprovableSince ?? null,
    holds: inspections
      .filter((entry) => !entry.valid)
      .map((entry) => ({
        receipt: entry.inspect.receipt,
        site: entry.inspect.site,
        time: entry.inspect.time,
        reasons: entry.gaps.map((detail) => detail.reason),
      })),
  };
}

export function partState(ledger, part) {
  const crates = crateHistory(ledger, part);
  const current = crates.filter((parcel) => !(ledger.childrenByParent.get(parcel.caseSeal)?.length)).at(-1) ?? null;
  const last = crates.at(-1) ?? null;
  const crate = current ?? last;
  const scoped = partStateInCrate(ledger, part, crate?.caseSeal);
  const closedInner = Boolean(crate && crate.inner[part]);
  const proof = scoped.provability;
  const breakAt = timeValue(proof?.unprovableSince?.time ?? null);
  // 断点之后如果已有本站的实物点验，Custody 由该次点验直接重新建立；
  // 但“从哪一代起签收断了”仍然保留在账上，便于交接同事追溯。
  const reestablishedAt =
    scoped.validInspection &&
    proof?.unprovableSince &&
    (breakAt === null ||
      (scoped.validInspection.inspect.at !== null &&
        scoped.validInspection.inspect.at > breakAt))
      ? scoped.validInspection.inspect
      : null;

  return {
    part,
    crate,
    currentCrate: current,
    lastCrate: last,
    inCrate: Boolean(current),
    closedInner,
    innerBox: crate?.inner[part] ?? null,
    inspections: scoped.inspections,
    validInspection: scoped.validInspection,
    latestInspection: scoped.latestInspection,
    verified: scoped.verified,
    verifiedAt: scoped.verifiedAt,
    custodian: scoped.verifiedAt
      ? custodianAfter(ledger, crate.caseSeal, scoped.verifiedAt.site, scoped.validInspection.inspect.at)
      : null,
    provability: proof,
    unprovableSince: proof?.unprovableSince ?? null,
    custodyReestablishedAt: reestablishedAt
      ? { receipt: reestablishedAt.receipt, site: reestablishedAt.site, time: reestablishedAt.time }
      : null,
    // 该件是否已有可用的监管链：签收链完整，或断点后有一次本站实物点验兜底
    custodyProven: Boolean(proof?.provable || reestablishedAt),
    // 出借方允许封闭内盒原样周转：件随箱移动，但点验状态仍是未知
    verificationUnknown: closedInner && !scoped.verified,
    holds: scoped.holds,
  };
}

// ---------------------------------------------------------------------------
// 作品交付
// ---------------------------------------------------------------------------

export function workReadiness(ledger, workId, { site = null, at = null } = {}) {
  const work = ledger.works.find((entry) => entry.workId === workId);
  if (!work) throw new Error(`未知作品 ${workId}`);
  const when = at ?? ledger.maxAt;
  const parts = work.parts.map((part) => {
    const state = partState(ledger, part);
    const crate = state.crate;
    const relevantSite = site ?? crate?.site ?? null;
    const installation =
      crate && relevantSite
        ? authorityFor(ledger, {
            site: relevantSite,
            part,
            operation: '安装',
            at: when,
            caseSeal: crate.caseSeal,
            manifest: crate.version,
          })
        : { allowed: false, permits: [], presences: [], ids: [] };
    const reasons = [];
    if (!state.verified) {
      if (state.verificationUnknown) reasons.push('封闭内盒原样周转：件随箱移动，但点验状态未知');
      else if (state.latestInspection) reasons.push(...state.latestInspection.gaps.map((detail) => detail.reason));
      else reasons.push('本站没有有效点验凭据');
    } else if (site && state.verifiedAt.site !== site) {
      reasons.push(`有效点验在 ${state.verifiedAt.site}，不在本站 ${site}`);
    }
    if (!installation.allowed) reasons.push('本站没有覆盖该部件的有效安装许可');
    if (!state.custodyProven) {
      reasons.push(`自 ${sealLabel(state.unprovableSince)} 起无法证明：${state.unprovableSince.reason}`);
    }
    return {
      part,
      ok:
        state.verified &&
        installation.allowed &&
        state.custodyProven &&
        (!site || state.verifiedAt?.site === site),
      verified: state.verified,
      verifiedAt: state.verifiedAt,
      installationAllowed: installation.allowed,
      installationAuthority: installation.ids,
      custodian: state.custodian,
      state,
      reasons: unique(reasons),
    };
  });
  const blocked = parts.filter((entry) => !entry.ok);
  return {
    workId,
    site,
    at: when,
    ready: blocked.length === 0,
    parts,
    blockedParts: blocked.map((entry) => entry.part),
    readyParts: parts.filter((entry) => entry.ok).map((entry) => entry.part),
    // 只报告本作品的阻挡原因；其他作品被挂起的部件不影响本作品
    reasons: unique(blocked.flatMap((entry) => entry.reasons)),
  };
}

export function workShortage(ledger, workId, { site = null } = {}) {
  const work = ledger.works.find((entry) => entry.workId === workId);
  if (!work) throw new Error(`未知作品 ${workId}`);
  const details = work.parts.map((part) => {
    const state = partState(ledger, part);
    return {
      part,
      verified: state.verified,
      verifiedAt: state.verifiedAt,
      caseSeal: state.crate?.caseSeal ?? null,
      site: state.crate?.site ?? null,
      closedInner: state.closedInner,
      innerBox: state.innerBox,
      verificationUnknown: state.verificationUnknown,
      unprovableSince: state.unprovableSince,
      custodyProven: state.custodyProven,
      custodyReestablishedAt: state.custodyReestablishedAt,
      holds: state.holds,
    };
  });
  const missing = details.filter((entry) => !entry.verified);
  return {
    workId,
    site,
    required: work.parts,
    missing: missing.map((entry) => entry.part),
    complete: missing.length === 0,
    details,
  };
}

// ---------------------------------------------------------------------------
// 箱级交接视图
// ---------------------------------------------------------------------------

export function crateView(ledger, caseSeal, { site = null, at = null } = {}) {
  const parcel = ledger.parcelBySeal.get(caseSeal);
  if (!parcel) throw new Error(`未知箱号/封条 ${caseSeal}`);
  const when = at ?? ledger.maxAt;
  const relevantSite = site ?? parcel.site;
  const arrival = arrivalState(ledger, caseSeal);
  const presence = presenceFor(ledger, caseSeal, relevantSite, when);
  const opens = explicitOpens(ledger, caseSeal).map((entry) => evaluateOpen(ledger, entry));
  const inspections = ledger.inspects
    .filter((entry) => entry.caseSeal === caseSeal)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
    .map((entry) => evaluateInspection(ledger, entry));
  const handoffs = ledger.handoffs
    .filter((entry) => entry.caseSeal === caseSeal)
    .map((entry) => handoffValidity(ledger, entry));
  const proof = provability(ledger, caseSeal);

  const operations = parcel.contents.map((part) => {
    const perOperation = {};
    for (const operation of ['开封', '点验', '安装']) {
      const authority = authorityFor(ledger, {
        site: relevantSite,
        part,
        operation,
        at: when,
        caseSeal,
        manifest: parcel.version,
      });
      perOperation[operation] = {
        permitted: authority.allowed,
        ids: authority.ids,
        // 已领用的许可只对现场确证的封条和当前点验清单有效
        requiresSealConfirmation: true,
        manifest: parcel.version,
        crateChecks: authority.permits.map((permit) => permitUsableForCrate(permit, parcel)),
      };
    }
    const state = partStateInCrate(ledger, part, caseSeal);
    const closedInner = Boolean(parcel.inner[part]);
    return {
      part,
      operations: perOperation,
      verified: state.verified,
      verifiedAt: state.verifiedAt,
      closedInner,
      verificationUnknown: closedInner && !state.verified,
      unprovableSince: state.unprovableSince,
      holds: state.holds,
    };
  });

  // 同箱其他部件：只获准点验其中一件时，整箱开封请求挂起。
  // 外层部件与封闭内盒里的件分开算：内盒件只有未获放行时才构成暴露。
  const isInspectable = (part) =>
    operations.find((entry) => entry.part === part)?.operations.点验.permitted ?? false;
  const isClosedTransferred = (part) =>
    Boolean(
      parcel.inner[part] &&
        ledger.permits.some((permit) => permit.site === relevantSite && has(permit.closedTransfer, parcel.inner[part])),
    );
  const inspectable = parcel.contents.filter(isInspectable);
  const exposed = parcel.contents.filter((part) => !isInspectable(part) && !isClosedTransferred(part));
  const holdWholeCrate = inspectable.length > 0 && exposed.length > 0;
  const holdReasons = holdWholeCrate
    ? exposed.map((part) => `${part} 未获准点验：开箱会暴露该部件，库房须挂起整箱开封请求并告知出借方`)
    : [];
  if (exposed.length === 0) {
    for (const part of parcel.contents.filter((entry) => isClosedTransferred(entry))) {
      holdReasons.push(`${part} 在封闭内盒 ${parcel.inner[part]} 内原样周转：随箱移动，但点验状态仍未知`);
    }
  }

  const slots = ledger.slots.filter(
    (entry) => (!site || entry.site === site) && (!entry.caseSeal || entry.caseSeal === caseSeal),
  );

  return {
    caseSeal,
    route: parcel.route,
    site: parcel.site,
    version: parcel.version,
    mode: parcel.mode,
    parent: parcel.parent,
    current: !(ledger.childrenByParent.get(caseSeal)?.length),
    lineage: (() => {
      const chain = [];
      let cursor = parcel;
      while (cursor) {
        chain.push({
          caseSeal: cursor.caseSeal,
          version: cursor.version,
          mode: cursor.mode,
          site: cursor.site,
          time: cursor.time,
          parts: cursor.parts,
          inner: cursor.inner,
        });
        cursor = cursor.parentParcel;
      }
      return chain;
    })(),
    parts: parcel.parts,
    contents: parcel.contents,
    inner: parcel.inner,
    arrival: {
      arrived: arrival.arrived,
      intact: arrival.intact,
      record: arrival.arrival,
      sealedAtSource: arrival.sealedAtSource,
    },
    presence,
    breaks: sealBreaks(ledger, caseSeal).map((entry) => ({
      kind: entry.kind,
      time: entry.time,
      site: entry.site,
      record: entry.record,
      mode: entry.mode ?? null,
      childSeal: entry.childSeal ?? null,
    })),
    opens: opens.map((entry) => ({
      receipt: entry.open.receipt,
      site: entry.open.site,
      time: entry.open.time,
      valid: entry.valid,
      allowedParts: entry.allowedParts,
      exposure: entry.exposure,
      holdWholeCrate: entry.holdWholeCrate,
      gaps: entry.gaps.map((detail) => detail.reason),
    })),
    inspections: inspections.map((entry) => ({
      receipt: entry.inspect.receipt,
      part: entry.part,
      site: entry.inspect.site,
      time: entry.inspect.time,
      photo: entry.inspect.photo,
      valid: entry.valid,
      basis: entry.access.basis,
      openingUnrecorded: entry.openingUnrecorded,
      gaps: entry.gaps.map((detail) => detail.reason),
    })),
    handoffs: handoffs.map((entry) => ({
      receipt: entry.handoff.receipt,
      site: entry.handoff.site,
      time: entry.handoff.time,
      manifest: entry.handoff.manifest,
      valid: entry.valid,
      gaps: entry.gaps.map((detail) => detail.reason),
    })),
    custodian: ledger.seals.filter((entry) => entry.caseSeal === caseSeal).at(-1) ?? null,
    provability: proof,
    operations,
    holdWholeCrate,
    holdReasons,
    slots: slots.map((slot) => ({ id: slot.id, operator: slot.operator, from: slot.from, to: slot.to, parts: slot.parts })),
  };
}

// 按部件看：在哪只箱、哪家馆、从哪一代起无法证明
export function crateScopeByPart(ledger, parts) {
  return parts.map((part) => {
    const state = partState(ledger, part);
    return {
      part,
      caseSeal: state.crate?.caseSeal ?? null,
      site: state.crate?.site ?? null,
      version: state.crate?.version ?? null,
      mode: state.crate?.mode ?? null,
      current: Boolean(state.currentCrate),
      verified: state.verified,
      verifiedAt: state.verifiedAt,
      closedInner: state.closedInner,
      innerBox: state.innerBox,
      verificationUnknown: state.verificationUnknown,
      unprovableSince: state.unprovableSince,
      custodyProven: state.custodyProven,
      custodyReestablishedAt: state.custodyReestablishedAt,
      holds: state.holds,
    };
  });
}

// ---------------------------------------------------------------------------
// 排期闸门
// ---------------------------------------------------------------------------

// 许可到期或封条核对失败后：尚未动过的箱停止排进后续点验；
// 已经开过的箱要核对当时有没有获准、谁接手封存，不能当成还没开过。
export function slotReadiness(ledger, caseSeal, { site, at }) {
  const parcel = ledger.parcelBySeal.get(caseSeal);
  if (!parcel) return { caseSeal, site, at, ready: false, reasons: ['箱不存在'], touched: false };
  const presence = presenceFor(ledger, caseSeal, site, at);
  const arrival = arrivalState(ledger, caseSeal);
  const superseded = (ledger.childrenByParent.get(caseSeal) ?? []).find((child) => atOrBefore(child.at, at)) ?? null;
  const opensBefore = explicitOpens(ledger, caseSeal).filter((entry) => atOrBefore(entry.at, at));
  const touched = opensBefore.length > 0;
  const evaluated = opensBefore.map((entry) => evaluateOpen(ledger, entry));
  const unauthorized = evaluated.find((entry) => !entry.valid) ?? null;
  const held = evaluated.find((entry) => entry.holdWholeCrate) ?? null;
  const lastOpenAt = opensBefore.at(-1)?.at ?? null;
  const sealedAfter = touched
    ? ledger.seals.some(
        (entry) =>
          entry.caseSeal === caseSeal &&
          (!site || entry.site === site) &&
          atOrAfter(entry.at, lastOpenAt),
      )
    : true;
  const custodian = sealedAfter
    ? custodianAfter(ledger, caseSeal, site, lastOpenAt) ?? ledger.seals.filter((entry) => entry.caseSeal === caseSeal).at(-1) ?? null
    : null;

  const reasons = [];
  if (!presence.present) reasons.push('该箱尚未到达本馆，不能排期');
  if (presence.basis === 'arrival' && !arrival.intact) {
    reasons.push('封条核对失败：封箱时的完整证明不能沿用');
  }
  if (superseded) {
    reasons.push(`该箱已在 ${superseded.time ?? ''} 换箱为 ${superseded.caseSeal}，不能再按原箱排期`);
  }
  if (touched && unauthorized) {
    reasons.push('已有开封在开箱当时没有获准，不能当成还没开过');
    for (const detail of unauthorized.gaps) reasons.push(detail.reason);
  }
  if (touched && !sealedAfter) reasons.push('已开箱，但没有当场封存与接手人记录');
  if (held) reasons.push('开箱会暴露未获准点验的同箱部件，需核对当时授权范围并告知出借方');

  // 预排时同样要检查：只获准点验其中一件、而开箱会暴露其他部件，整箱请求先挂起
  const plannedScope = parcel.parts.map((part) => ({
    part,
    canInspect: authorityFor(ledger, { site, part, operation: '点验', at, caseSeal, manifest: parcel.version }).allowed,
    closedTransfer: Boolean(
      parcel.inner[part] &&
        ledger.permits.some((permit) => permit.site === site && has(permit.closedTransfer, parcel.inner[part])),
    ),
  }));
  const plannedExposure = plannedScope.filter((entry) => !entry.canInspect && !entry.closedTransfer).map((entry) => entry.part);
  const plannedHold = plannedScope.some((entry) => entry.canInspect) && plannedExposure.length > 0;
  if (plannedHold) {
    reasons.push(`预排范围只覆盖部分部件；开箱会暴露 ${plannedExposure.join('、')}，须先挂起整箱请求并告知出借方`);
  }

  const permittedOps = parcel.parts.map((part) => ({
    part,
    operations: ['开封', '点验', '安装'].filter((operation) =>
      authorityFor(ledger, { site, part, operation, at, caseSeal, manifest: parcel.version }).allowed,
    ),
    permitChecks: ledger.permits
      .filter((permit) => permit.site === site && has(permit.parts, part))
      .map((permit) => ({ id: permit.id, ...permitUsableForCrate(permit, parcel) })),
  }));
  if (!permittedOps.some((entry) => entry.operations.length > 0)) {
    reasons.push('该馆在此时段没有覆盖任何部件的有效许可（可能已到期或不适用于当前封条/清单）');
  }
  const invalidPermit = permittedOps.flatMap((entry) => entry.permitChecks).find((entry) => !entry.usable);
  if (invalidPermit) {
    reasons.push(`许可 ${invalidPermit.id} 与现场封条或清单版本不符，需重新核对`);
  }

  // 库房有开箱工作时段时，预排必须落在当值窗口内，并指明经办人
  const siteSlots = ledger.slots.filter(
    (entry) => entry.site === site && (!entry.caseSeal || entry.caseSeal === caseSeal),
  );
  const matchedSlot =
    at === null || at === undefined
      ? null
      : siteSlots.find((entry) => within(at, entry.fromAt, entry.toAt)) ?? null;
  if (siteSlots.length > 0 && at !== null && at !== undefined && !matchedSlot) {
    reasons.push(`预排时间不在 ${site} 的开箱工作时段内`);
  }

  return {
    caseSeal,
    site,
    at,
    ready: reasons.length === 0,
    touched,
    opened: touched,
    operator: matchedSlot?.operator ?? null,
    slot: matchedSlot ? { id: matchedSlot.id, from: matchedSlot.from, to: matchedSlot.to, operator: matchedSlot.operator } : null,
    superseded: superseded ? superseded.caseSeal : null,
    breached: presence.basis === 'arrival' && !arrival.intact,
    plannedExposure,
    plannedHold,
    unauthorizedOpen: unauthorized
      ? {
          receipt: unauthorized.open.receipt,
          time: unauthorized.open.time,
          reasons: unauthorized.gaps.map((detail) => detail.reason),
        }
      : null,
    heldOpen: held ? { receipt: held.open.receipt, time: held.open.time, exposure: held.exposure } : null,
    custodian,
    reasons: unique(reasons),
    permittedOps,
  };
}

export { timeValue };
