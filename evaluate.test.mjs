import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './source-server.mjs';
import { collectAll } from './collect.mjs';
import { buildLedger, currentCrates, lineageOf } from './ledger.mjs';
import {
  crateView,
  crateScopeByPart,
  partState,
  provability,
  slotReadiness,
  timeValue,
  workReadiness,
  workShortage,
} from './evaluate.mjs';
import { loadHandover } from './handover.mjs';

const t = (clock) => timeValue(clock);

// 用来源记录的形状直接构造账本，便于单独验证每条规则。
function ledgerOf(entries) {
  return buildLedger(
    entries.map((entry, index) => ({
      record: entry.record ?? `t-${index + 1}`,
      kind: entry.kind,
      availableFrom: 1,
      payload: entry,
    })),
  );
}

const basePacking = (overrides = {}) => ({
  kind: 'packing',
  caseSeal: 'C1',
  route: 'R1',
  site: '甲馆',
  version: 1,
  parts: ['A', 'B'],
  ...overrides,
});

const baseWorld = (overrides = {}) => [
  basePacking(),
  { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
  { kind: 'handoff', receipt: 'H1', caseSeal: 'C1', manifest: 1, site: '甲馆', time: '09:10' },
  {
    kind: 'permit',
    permit: 'P-ALL',
    site: '甲馆',
    parts: ['A', 'B'],
    scope: ['开封', '点验', '安装'],
  },
  { kind: 'work', workId: 'W1', parts: ['A', 'B'] },
  ...(overrides.extra ?? []),
];

// ---------------------------------------------------------------------------
// 采集
// ---------------------------------------------------------------------------

test('按阶段翻页采集，记录只增不改，并标出首次出现的阶段', async (t2) => {
  const { server, url } = await start();
  t2.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const data = await collectAll(url, { pageSize: 1 });
  assert.equal(data.stages, 4);
  assert.equal(data.records.length, 11);
  assert.equal(new Set(data.records.map((entry) => entry.record)).size, 11);

  const byStage = data.byStage.map((entry) => entry.records.length);
  assert.deepEqual(byStage, [7, 2, 2, 0]);
  const later = data.records.find((entry) => entry.record === 'carrier-4');
  assert.equal(later.seenAtStage, 3);
  assert.equal(later.kind, 'repack');
  // 晚到的分箱更正仍然保留原始业务时间
  assert.equal(later.payload.time, '11:40');
});

test('采集失败要显式报错，不能静默丢记录', async (t2) => {
  const { server, url } = await start();
  t2.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  await assert.rejects(() => collectAll(`${url}/source/nope`, { pageSize: 2 }));
});

// ---------------------------------------------------------------------------
// 版本链与换箱语义
// ---------------------------------------------------------------------------

test('换外箱不改内容，重新分装按新清单处理，两者都能回溯到原箱', () => {
  const ledger = ledgerOf([
    basePacking(),
    {
      kind: 'repack',
      parent: 'C1',
      caseSeal: 'C2',
      caseSeal2: undefined,
      site: '乙馆',
      version: 2,
      mode: '换外箱',
      parts: ['A', 'B'],
      time: '10:00',
    },
    {
      kind: 'repack',
      parent: 'C2',
      caseSeal: 'C3',
      site: '丙馆',
      version: 3,
      mode: '重新分装',
      parts: ['A', 'C'],
      time: '11:00',
    },
  ]);
  assert.deepEqual(
    lineageOf(ledger, 'C3').map((parcel) => parcel.caseSeal),
    ['C3', 'C2', 'C1'],
  );
  assert.deepEqual(ledger.parcelBySeal.get('C2').parts, ['A', 'B']);
  assert.deepEqual(ledger.parcelBySeal.get('C3').parts, ['A', 'C']);
  assert.equal(ledger.parcelBySeal.get('C3').mode, '重新分装');
  assert.equal(ledger.issues.length, 0);
});

test('换外箱却改内容、版本不递增、重新分装不交清单都会记为账本问题', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'repack', parent: 'C1', caseSeal: 'C2', site: '乙馆', version: 2, mode: '换外箱', parts: ['A'], time: '10:00' },
    { kind: 'repack', parent: 'C2', caseSeal: 'C3', site: '丙馆', version: 2, mode: '重新分装', parts: ['A'], time: '11:00' },
    { kind: 'repack', parent: 'C3', caseSeal: 'C4', site: '丁馆', version: 4, mode: '重新分装', time: '12:00' },
  ]);
  const codes = ledger.issues.map((entry) => entry.code);
  assert.ok(codes.includes('outer-swap-changed-parts'));
  assert.ok(codes.includes('version-not-increasing'));
  assert.ok(codes.includes('repack-parts-missing'));
});

test('封闭内盒里的件随箱移动，但重新分装清单不交代去向时要标出', () => {
  const ledger = ledgerOf([
    basePacking({ parts: ['A'], inner: { B: 'I1' } }),
    { kind: 'repack', parent: 'C1', caseSeal: 'C2', site: '乙馆', version: 2, mode: '重新分装', parts: ['A'], time: '10:00' },
  ]);
  const issue = ledger.issues.find((entry) => entry.code === 'inner-unaccounted');
  assert.ok(issue);
  assert.deepEqual(issue.parts, ['B']);
  // 内容仍旧包含内盒里的件
  assert.deepEqual(ledger.parcelBySeal.get('C1').contents, ['A', 'B']);
});

// ---------------------------------------------------------------------------
// 许可：部件 × 场馆 × 操作，以及在场许可与撤销
// ---------------------------------------------------------------------------

test('许可按部件、场馆、操作生效，不能跨馆或跨部件借用', () => {
  const ledger = ledgerOf(baseWorld());
  const view = crateView(ledger, 'C1', { site: '乙馆' });
  assert.equal(view.operations[0].operations.开封.permitted, false);
  assert.equal(crateView(ledger, 'C1', { site: '甲馆' }).operations[0].operations.开封.permitted, true);

  const narrow = ledgerOf([
    basePacking(),
    { kind: 'permit', permit: 'P-A', site: '甲馆', parts: ['A'], scope: ['点验', '安装'] },
  ]);
  const narrowView = crateView(narrow, 'C1', { site: '甲馆' });
  const byPart = Object.fromEntries(narrowView.operations.map((entry) => [entry.part, entry.operations]));
  assert.equal(byPart.A.点验.permitted, true);
  assert.equal(byPart.A.开封.permitted, false);
  assert.equal(byPart.B.点验.permitted, false);
});

test('临时在场许可只在时段内补充操作，过期后不再生效', () => {
  const ledger = ledgerOf([
    basePacking(),
    {
      kind: 'presence',
      presence: 'PR1',
      permit: 'P-ALL',
      site: '甲馆',
      caseSeal: 'C1',
      manifest: 1,
      operations: ['开封'],
      from: '10:00',
      to: '10:30',
    },
  ]);
  const inWindow = crateView(ledger, 'C1', { site: '甲馆', at: t('10:10') });
  const afterWindow = crateView(ledger, 'C1', { site: '甲馆', at: t('10:31') });
  assert.equal(inWindow.operations[0].operations.开封.permitted, true);
  assert.equal(afterWindow.operations[0].operations.开封.permitted, false);
});

test('许可撤销后，撤销点之后的现场操作不再获准，撤销之前的仍然成立', () => {
  const ledger = ledgerOf([
    ...baseWorld(),
    { kind: 'revoke', permit: 'P-ALL', time: '11:00' },
  ]);
  const before = crateView(ledger, 'C1', { site: '甲馆', at: t('10:30') });
  const after = crateView(ledger, 'C1', { site: '甲馆', at: t('11:30') });
  assert.equal(before.operations[0].operations.点验.permitted, true);
  assert.equal(after.operations[0].operations.点验.permitted, false);
});

test('已领用的许可只对写明的封条和清单版本有效', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'permit', permit: 'P-OLD', site: '甲馆', seal: 'C0', manifest: 1, parts: ['A'], scope: ['点验'] },
    { kind: 'permit', permit: 'P-V1', site: '甲馆', seal: 'C1', manifest: 1, parts: ['A'], scope: ['点验'] },
    { kind: 'repack', parent: 'C1', caseSeal: 'C2', site: '甲馆', version: 2, mode: '换外箱', parts: ['A', 'B'], time: '10:00' },
  ]);
  const view = crateView(ledger, 'C2', { site: '甲馆' });
  const part = view.operations.find((entry) => entry.part === 'A');
  assert.equal(part.operations.点验.permitted, false);
  assert.ok(part.operations.点验.crateChecks.every((check) => check.usable === false));
  assert.equal(crateView(ledger, 'C1', { site: '甲馆' }).operations[0].operations.点验.permitted, true);
});

// ---------------------------------------------------------------------------
// 到站、签收与可证明性
// ---------------------------------------------------------------------------

test('签收必须与封条及清单版本对应，且发生在到站之后', () => {
  const good = ledgerOf(baseWorld());
  assert.equal(provability(good, 'C1').provable, true);
  assert.equal(crateView(good, 'C1').handoffs[0].valid, true);

  const wrongManifest = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'handoff', receipt: 'H9', caseSeal: 'C1', manifest: 2, site: '甲馆', time: '09:10' },
  ]);
  assert.equal(provability(wrongManifest, 'C1').provable, false);
  assert.match(provability(wrongManifest, 'C1').unprovableSince.reason, /清单版本/);

  const beforeArrival = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:30', seal: '完整' },
    { kind: 'handoff', receipt: 'H8', caseSeal: 'C1', manifest: 1, site: '甲馆', time: '09:10' },
  ]);
  assert.equal(crateView(beforeArrival, 'C1').handoffs[0].valid, false);
});

test('换箱后上一馆的签收仍可查，但新一代内容从没有签收处起无法证明', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'handoff', receipt: 'H1', caseSeal: 'C1', manifest: 1, site: '甲馆', time: '09:10' },
    { kind: 'repack', parent: 'C1', caseSeal: 'C2', site: '乙馆', version: 2, mode: '重新分装', parts: ['A'], time: '11:00' },
  ]);
  const proof = provability(ledger, 'C2');
  assert.equal(proof.provable, false);
  assert.equal(proof.unprovableSince.caseSeal, 'C2');
  // 原签收仍然能取到，也仍然有效
  const prior = proof.points.find((point) => point.parcel.caseSeal === 'C1');
  assert.equal(prior.validHandoff.handoff.receipt, 'H1');
  assert.equal(prior.validHandoff.valid, true);
});

test('分箱更正晚到时，下一馆已完成的实物点验仍然可用，超出授权范围的部分另行挂起', async (t2) => {
  const { server, url } = await start();
  t2.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const data = await collectAll(url);
  const ledger = buildLedger(data.records);

  // K1：谷馆在重新分装之后当面点验，实物凭据成立
  const k1 = partState(ledger, 'K1');
  assert.equal(k1.verified, true);
  assert.equal(k1.verifiedAt.receipt, 'H5');
  assert.equal(k1.verifiedAt.basis, 'repacked-here');

  // 但 SE05 这一代本身没有签收，账上仍要标出“从哪一代起无法证明”
  assert.equal(k1.unprovableSince.caseSeal, 'SE05');
  assert.equal(k1.unprovableSince.version, 2);
  assert.equal(k1.custodyProven, true);
  assert.equal(k1.custodyReestablishedAt.receipt, 'H5');

  // P3：不在谷馆的许可范围内，点验不能算数
  const p3 = partState(ledger, 'P3');
  assert.equal(p3.verified, false);
  assert.ok(p3.holds.some((hold) => hold.reasons.some((reason) => /点验许可/.test(reason))));

  // 山馆那一次签收仍然保留且有效
  const se01 = crateView(ledger, 'SE01');
  assert.equal(se01.handoffs.some((entry) => entry.receipt === 'H2' && entry.valid), true);
  assert.equal(se01.current, false);
});

// ---------------------------------------------------------------------------
// 开封：同箱暴露与整箱挂起
// ---------------------------------------------------------------------------

test('只获准点验一件、开箱会暴露其他件时，整箱开封请求挂起并说明缘由', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'permit', permit: 'P-B', site: '甲馆', parts: ['B'], scope: ['点验'] },
  ]);
  const view = crateView(ledger, 'C1', { site: '甲馆' });
  assert.equal(view.holdWholeCrate, true);
  assert.deepEqual(view.operations.map((entry) => entry.part), ['A', 'B']);
  assert.ok(view.holdReasons.some((reason) => reason.includes('A') && reason.includes('开箱会暴露')));

  // 预先排期同样要挡住，而不是等到现场才发现
  const slot = slotReadiness(ledger, 'C1', { site: '甲馆', at: t('10:00') });
  assert.equal(slot.ready, false);
  assert.deepEqual(slot.plannedExposure, ['A']);
});

test('出借方允许封闭内盒原样周转时，盒内件不构成开箱暴露，但点验状态仍是未知', () => {
  const ledger = ledgerOf([
    basePacking({ parts: ['A'], inner: { B: 'IB' } }),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'permit', permit: 'P-A', site: '甲馆', parts: ['A'], scope: ['开封', '点验'], closedTransfer: ['IB'] },
    { kind: 'work', workId: 'W1', parts: ['A', 'B'] },
  ]);
  const view = crateView(ledger, 'C1', { site: '甲馆' });
  assert.equal(view.holdWholeCrate, false);
  const b = view.operations.find((entry) => entry.part === 'B');
  assert.equal(b.closedInner, true);
  assert.equal(b.verificationUnknown, true);
  assert.equal(b.verified, false);

  const work = workShortage(ledger, 'W1');
  // A 未点验、B 在封闭内盒里：两件都还缺，但只有 B 是“状态未知”
  assert.deepEqual(work.missing, ['A', 'B']);
  assert.ok(work.details.find((entry) => entry.part === 'B').verificationUnknown);
  assert.equal(work.details.find((entry) => entry.part === 'A').verificationUnknown, false);
});

test('没有封闭内盒放行时，盒内未获准件仍按暴露处理', () => {
  const ledger = ledgerOf([
    basePacking({ parts: ['A'], inner: { B: 'IB' } }),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'permit', permit: 'P-A', site: '甲馆', parts: ['A'], scope: ['开封', '点验'] },
  ]);
  const view = crateView(ledger, 'C1', { site: '甲馆' });
  assert.equal(view.holdWholeCrate, true);
  assert.ok(view.holdReasons.some((reason) => reason.includes('B')));
});

test('有效点验必须发生在获准开封之后，同箱未获准的开封会污染其后的点验', () => {
  const approved = ledgerOf([
    ...baseWorld(),
    {
      kind: 'open',
      receipt: 'O1',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:20',
      outer: { sealBreak: true, part: 'A', operations: ['开封'] },
    },
    { kind: 'inspect', receipt: 'I1', caseSeal: 'C1', part: 'A', site: '甲馆', time: '09:30', photo: 'IMG1', open: 'O1' },
    { kind: 'sealed', caseSeal: 'C1', site: '甲馆', time: '09:40', by: '张三' },
  ]);
  assert.equal(partState(approved, 'A').verified, true);
  assert.equal(partState(approved, 'A').custodian.by, '张三');

  const beforeOpen = ledgerOf([
    ...baseWorld(),
    { kind: 'inspect', receipt: 'I2', caseSeal: 'C1', part: 'A', site: '甲馆', time: '09:30', photo: 'IMG1' },
    {
      kind: 'open',
      receipt: 'O2',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:40',
      outer: { sealBreak: true, part: 'A', operations: ['开封'] },
    },
  ]);
  assert.equal(partState(beforeOpen, 'A').verified, false);
});

test('点验凭据不能张冠李戴：照片不能跨部件、跨箱复用', () => {
  const ledger = ledgerOf([
    ...baseWorld(),
    { kind: 'photo', photo: 'IMG-A', part: 'B', caseSeal: 'C1' },
    { kind: 'photo', photo: 'IMG-X', part: 'A', caseSeal: 'C9' },
    {
      kind: 'open',
      receipt: 'O1',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:20',
      outer: { sealBreak: true, part: 'A', operations: ['开封'] },
    },
    { kind: 'inspect', receipt: 'I1', caseSeal: 'C1', part: 'A', site: '甲馆', time: '09:30', photo: 'IMG-A', open: 'O1' },
    { kind: 'inspect', receipt: 'I2', caseSeal: 'C1', part: 'A', site: '甲馆', time: '09:31', photo: 'IMG-X', open: 'O1' },
  ]);
  const first = crateView(ledger, 'C1').inspections.find((entry) => entry.receipt === 'I1');
  const second = crateView(ledger, 'C1').inspections.find((entry) => entry.receipt === 'I2');
  assert.equal(first.valid, false);
  assert.ok(first.gaps.some((gap) => gap.includes('不是本部件')));
  assert.equal(second.valid, false);
  assert.ok(second.gaps.some((gap) => gap.includes('另一只箱')));
});

// ---------------------------------------------------------------------------
// 作品交付
// ---------------------------------------------------------------------------

test('只有必要部件都能关联到有效点验、且安装许可仍有效时，作品才交给布展', () => {
  const ledger = ledgerOf([
    ...baseWorld(),
    {
      kind: 'open',
      receipt: 'O1',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:20',
      outer: { sealBreak: true, parts: ['A', 'B'], operations: ['开封'] },
    },
    { kind: 'inspect', receipt: 'I1', caseSeal: 'C1', part: 'A', site: '甲馆', time: '09:30', open: 'O1' },
    { kind: 'inspect', receipt: 'I2', caseSeal: 'C1', part: 'B', site: '甲馆', time: '09:31', open: 'O1' },
    { kind: 'sealed', caseSeal: 'C1', site: '甲馆', time: '09:40', by: '李四' },
  ]);
  const ready = workReadiness(ledger, 'W1', { site: '甲馆' });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.readyParts, ['A', 'B']);

  // 安装许可到期后不能交付
  const expired = ledgerOf([
    ...baseWorld(),
    { kind: 'revoke', permit: 'P-ALL', time: '10:00' },
    {
      kind: 'open',
      receipt: 'O1',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:20',
      outer: { sealBreak: true, parts: ['A', 'B'], operations: ['开封'] },
    },
    { kind: 'inspect', receipt: 'I1', caseSeal: 'C1', part: 'A', site: '甲馆', time: '09:30', open: 'O1' },
    { kind: 'inspect', receipt: 'I2', caseSeal: 'C1', part: 'B', site: '甲馆', time: '09:31', open: 'O1' },
  ]);
  const afterRevoke = workReadiness(expired, 'W1', { site: '甲馆', at: t('10:30') });
  assert.equal(afterRevoke.ready, false);
  assert.ok(afterRevoke.reasons.some((reason) => /安装许可/.test(reason)));
});

test('被挂起的部件不阻挡有独立有效凭据的其他作品', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'handoff', receipt: 'H1', caseSeal: 'C1', manifest: 1, site: '甲馆', time: '09:10' },
    { kind: 'work', workId: 'W-A', parts: ['A'] },
    { kind: 'work', workId: 'W-B', parts: ['B'] },
    { kind: 'permit', permit: 'P-A', site: '甲馆', parts: ['A'], scope: ['开封', '点验', '安装'] },
    { kind: 'permit', permit: 'P-B', site: '甲馆', parts: ['B'], scope: ['点验'] },
    {
      kind: 'open',
      receipt: 'O1',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:20',
      outer: { sealBreak: true, part: 'A', operations: ['开封'] },
    },
    { kind: 'inspect', receipt: 'I1', caseSeal: 'C1', part: 'A', site: '甲馆', time: '09:30', open: 'O1' },
    { kind: 'inspect', receipt: 'I2', caseSeal: 'C1', part: 'B', site: '甲馆', time: '09:31', open: 'O1' },
  ]);
  const workA = workReadiness(ledger, 'W-A', { site: '甲馆' });
  const workB = workReadiness(ledger, 'W-B', { site: '甲馆' });
  assert.equal(workA.ready, true);
  assert.equal(workB.ready, false);
  // W-B 的缺失不影响 W-A 的交付结论
  assert.deepEqual(workA.blockedParts, []);
  assert.ok(!workA.reasons.some((reason) => reason.includes('W-B')));
});

test('按作品能看到齐套缺失，以及从哪家馆哪次交接起无法证明', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'handoff', receipt: 'H1', caseSeal: 'C1', manifest: 1, site: '甲馆', time: '09:10' },
    { kind: 'work', workId: 'W1', parts: ['A', 'B'] },
    { kind: 'repack', parent: 'C1', caseSeal: 'C2', site: '乙馆', version: 2, mode: '重新分装', parts: ['A'], time: '11:00' },
  ]);
  const shortage = workShortage(ledger, 'W1');
  assert.deepEqual(shortage.missing, ['A', 'B']);
  const a = shortage.details.find((entry) => entry.part === 'A');
  assert.equal(a.unprovableSince.caseSeal, 'C2');
  assert.equal(a.unprovableSince.site, '乙馆');
  assert.equal(shortage.details.find((entry) => entry.part === 'B').caseSeal, 'C1');
});

// ---------------------------------------------------------------------------
// 排期闸门
// ---------------------------------------------------------------------------

test('许可到期后，没动过的箱停止排期', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'permit', permit: 'P1', site: '甲馆', parts: ['A', 'B'], scope: ['开封', '点验'], from: '09:00', to: '10:00' },
  ]);
  assert.equal(slotReadiness(ledger, 'C1', { site: '甲馆', at: t('09:30') }).ready, true);
  const expired = slotReadiness(ledger, 'C1', { site: '甲馆', at: t('10:30') });
  assert.equal(expired.ready, false);
  assert.equal(expired.touched, false);
  assert.ok(expired.reasons.some((reason) => /到期/.test(reason)));
});

test('封条核对失败后不能沿用封箱时的完整证明', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '异常' },
    { kind: 'permit', permit: 'P1', site: '甲馆', parts: ['A', 'B'], scope: ['开封', '点验'] },
  ]);
  const view = crateView(ledger, 'C1', { site: '甲馆' });
  assert.equal(view.arrival.intact, false);
  const slot = slotReadiness(ledger, 'C1', { site: '甲馆', at: t('09:30') });
  assert.equal(slot.ready, false);
  assert.ok(slot.reasons.some((reason) => /封条核对失败/.test(reason)));
});

test('已开箱的箱要核对当时是否获准、谁接手封存，不能当成还没开过', () => {
  const noCustodian = ledgerOf([
    ...baseWorld(),
    {
      kind: 'open',
      receipt: 'O1',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:20',
      outer: { sealBreak: true, part: 'A', operations: ['开封'] },
    },
  ]);
  const slot = slotReadiness(noCustodian, 'C1', { site: '甲馆', at: t('09:30') });
  assert.equal(slot.touched, true);
  assert.equal(slot.ready, false);
  assert.ok(slot.reasons.some((reason) => /没有当场封存/.test(reason)));

  const withCustodian = ledgerOf([
    ...baseWorld(),
    {
      kind: 'open',
      receipt: 'O1',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:20',
      outer: { sealBreak: true, part: 'A', operations: ['开封'] },
    },
    { kind: 'sealed', caseSeal: 'C1', site: '甲馆', time: '09:40', by: '王五' },
  ]);
  const ok = slotReadiness(withCustodian, 'C1', { site: '甲馆', at: t('09:50') });
  assert.equal(ok.ready, true);
  assert.equal(ok.custodian.by, '王五');
});

test('开箱时没有获准的箱要挂起核对，而不是按未开箱重排', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'permit', permit: 'P-B', site: '甲馆', parts: ['B'], scope: ['点验'] },
    {
      kind: 'open',
      receipt: 'O1',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:20',
      outer: { sealBreak: true, part: 'A', operations: ['开封'] },
    },
    { kind: 'sealed', caseSeal: 'C1', site: '甲馆', time: '09:40', by: '王五' },
  ]);
  const slot = slotReadiness(ledger, 'C1', { site: '甲馆', at: t('10:00') });
  assert.equal(slot.ready, false);
  assert.equal(slot.unauthorizedOpen.receipt, 'O1');
  assert.ok(slot.reasons.some((reason) => /不能当成还没开过/.test(reason)));
});

// ---------------------------------------------------------------------------
// 交接作业单
// ---------------------------------------------------------------------------

test('改表不等于改吊牌：运输清单与封箱清单不一致时标出需重新核对的部件', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'manifest', caseSeal: 'C1', version: 1, site: '甲馆', time: '09:30', parts: ['A', 'B', 'C'] },
  ]);
  const issue = ledger.issues.find((entry) => entry.code === 'manifest-drift-without-reseal');
  assert.ok(issue);
  assert.deepEqual(issue.parts, ['C']);
  assert.match(issue.reason, /重新核对/);
});

test('封条断开后不能沿用封箱时的完整证明签收，除非当场重新封存', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'permit', permit: 'P-ALL', site: '甲馆', parts: ['A', 'B'], scope: ['开封', '点验'] },
    {
      kind: 'open',
      receipt: 'O1',
      caseSeal: 'C1',
      site: '甲馆',
      time: '09:20',
      outer: { sealBreak: true, part: 'A', operations: ['开封'] },
    },
    { kind: 'handoff', receipt: 'H2', caseSeal: 'C1', manifest: 1, site: '甲馆', time: '09:30' },
  ]);
  const late = crateView(ledger, 'C1').handoffs.find((entry) => entry.receipt === 'H2');
  assert.equal(late.valid, false);
  assert.ok(late.gaps.some((gapText) => /完整证明不能沿用/.test(gapText)));

  ledger.seals.push({
    record: 'seal-1',
    caseSeal: 'C1',
    site: '甲馆',
    time: '09:25',
    at: t('09:25'),
    by: '赵六',
  });
  assert.equal(crateView(ledger, 'C1').handoffs.find((entry) => entry.receipt === 'H2').valid, true);
});

test('上一馆已凭旧清单签收、下一馆已点验一部分时，两边的凭据都保留，超出部分挂起核对', async (t2) => {
  const { server, url } = await start();
  t2.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const handover = await loadHandover({ url });

  // 上一馆：SE01 的 H2 签收仍然取得到、仍然有效
  const old = handover.crate('SE01');
  const h2 = old.handoffs.find((entry) => entry.receipt === 'H2');
  assert.equal(h2.valid, true);
  assert.equal(h2.manifest, 1);

  // 下一馆：K1 的实物点验被接受，P3 因超出授权而挂起
  const next = handover.crate('SE05', { site: '谷馆' });
  assert.equal(next.operations.find((entry) => entry.part === 'K1').verified, true);
  assert.equal(next.operations.find((entry) => entry.part === 'P3').verified, false);
  assert.equal(next.holdWholeCrate, true);

  // 原箱不再排期，新箱要按新清单重新签收
  assert.equal(handover.slot('SE01', { site: '山馆', at: '12:00' }).ready, false);
  const plan = handover.handoffPlan('SE05', { site: '谷馆' });
  assert.equal(plan.schedulable, false);
  assert.ok(plan.holdReasons.some((reason) => reason.includes('P3')));
});

test('预排要落在库房开箱工作时段内，并给出当值经办人', () => {
  const ledger = ledgerOf([
    basePacking(),
    { kind: 'arrival', caseSeal: 'C1', site: '甲馆', time: '09:00', seal: '完整' },
    { kind: 'permit', permit: 'P1', site: '甲馆', parts: ['A', 'B'], scope: ['开封', '点验'] },
    { kind: 'slot', slot: 'S1', site: '甲馆', operator: '周七', from: '10:00', to: '11:00' },
  ]);
  const inside = slotReadiness(ledger, 'C1', { site: '甲馆', at: t('10:30') });
  assert.equal(inside.ready, true);
  assert.equal(inside.operator, '周七');

  const outside = slotReadiness(ledger, 'C1', { site: '甲馆', at: t('09:30') });
  assert.equal(outside.ready, false);
  assert.ok(outside.reasons.some((reason) => /工作时段/.test(reason)));
});

test('交接视图按箱给出当前操作范围，按作品给出齐套缺失', async (t2) => {
  const { server, url } = await start();
  t2.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const handover = await loadHandover({ url });

  assert.deepEqual(handover.crates().sort(), ['SE02', 'SE05']);
  const plan = handover.handoffPlan('SE05', { site: '谷馆' });
  assert.equal(plan.version, 2);
  assert.equal(plan.mode, '重新分装');
  assert.equal(plan.holdWholeCrate, true);
  assert.equal(plan.schedulable, false);
  const k1 = plan.parts.find((entry) => entry.part === 'K1');
  assert.equal(k1.operations.点验.permitted, true);
  assert.equal(k1.verified, true);
  assert.equal(k1.verifiedAt.receipt, 'H5');

  const work = handover.work('W-J');
  assert.deepEqual(work.required, ['K1', 'K2']);
  assert.deepEqual(work.missing, ['K2']);
  const k1Scope = handover.byPart(['K1', 'P3']).find((entry) => entry.part === 'K1');
  assert.equal(k1Scope.caseSeal, 'SE05');
  assert.equal(k1Scope.unprovableSince.caseSeal, 'SE05');
});
