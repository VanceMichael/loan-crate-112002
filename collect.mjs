// 采集：切换回放阶段，按来源分页读取，记录每条记录首次出现的阶段。
// 阶段之间记录只会增加，不会变化；同一 record 键重复出现时要求内容一致。

export class CollectionError extends Error {}

async function readJson(response, context) {
  if (!response.ok) throw new CollectionError(`${context}：HTTP ${response.status}`);
  return response.json();
}

export async function collectSource(url, name, { pageSize = 2, stage, seen } = {}) {
  const records = [];
  let offset = 0;
  do {
    const response = await fetch(`${url}/source/${name}?offset=${offset}&limit=${pageSize}`);
    const page = await readJson(response, `来源 ${name} offset=${offset}`);
    if (page.stage !== stage) throw new CollectionError(`来源 ${name} 返回的阶段与请求不一致`);
    for (const entry of page.records) {
      if (!entry || typeof entry !== 'object') throw new CollectionError(`来源 ${name} 返回了无效记录`);
      if (typeof entry.record !== 'string' || entry.record.length === 0) {
        throw new CollectionError(`来源 ${name} 有记录缺少 record 键`);
      }
      // 记录键在各来源内唯一，跨来源可能重名，因此按来源分开去重
      const key = `${name}:${entry.record}`;
      const prior = seen.get(key);
      if (prior) {
        if (JSON.stringify(prior.payload ?? prior) !== JSON.stringify(entry.payload ?? entry)) {
          throw new CollectionError(`来源 ${name} 的记录 ${entry.record} 内容前后不一致`);
        }
        continue;
      }
      const copy = { ...entry, source: name, seenAtStage: stage };
      seen.set(key, copy);
      records.push(copy);
    }
    offset = page.next;
    if (offset !== null && (!Number.isInteger(offset) || offset < 0)) {
      throw new CollectionError(`来源 ${name} 返回了无效的下一页偏移`);
    }
  } while (offset !== null);
  return records;
}

export async function collectAll(url, { pageSize = 2 } = {}) {
  const overview = await readJson(await fetch(url), '来源总览');
  if (!Array.isArray(overview.sources) || overview.sources.length === 0) {
    throw new CollectionError('来源总览没有列出任何来源');
  }
  const stages = overview.stages;
  if (!Number.isInteger(stages) || stages < 1) throw new CollectionError('来源总览的阶段数无效');

  const seen = new Map();
  const records = [];
  const byStage = [];
  for (let stage = 1; stage <= stages; stage += 1) {
    const control = await fetch(`${url}/control?stage=${stage}`, { method: 'POST' });
    const confirmed = await readJson(control, `切换到阶段 ${stage}`);
    if (confirmed.stage !== stage) throw new CollectionError(`阶段 ${stage} 切换未确认`);
    const stageRecords = [];
    for (const name of overview.sources) {
      const fresh = await collectSource(url, name, { pageSize, stage, seen });
      stageRecords.push(...fresh);
    }
    records.push(...stageRecords);
    byStage.push({ stage, records: stageRecords });
  }

  return {
    overview,
    stages,
    records,
    byStage,
    firstSeen: (record, source = null) => {
      if (source) return seen.get(`${source}:${record}`)?.seenAtStage ?? null;
      const match = [...seen.entries()].find(([key]) => key.endsWith(`:${record}`));
      return match ? match[1].seenAtStage : null;
    },
  };
}
