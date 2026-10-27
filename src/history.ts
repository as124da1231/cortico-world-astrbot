/**
 * 历史检索：查这个 World 自己记下来的 QQ 消息。
 *
 * 数据来自 Cortico 的事件库（host.store），不是 AstrBot 的会话表：
 * 我们绕过了 AstrBot 的 LLM 阶段，它的会话上下文里没有这些对话；
 * 而每一条消息都已经作为 astrbot.message 事件落库，跨重启也在。
 */
import type {
  EventEnvelope,
  EventRangeQuery,
  EventStoreReader,
} from 'cortico/core/types.ts';
import { renderEventLines } from 'cortico/core/util.ts';
import type { Conv } from './driver.ts';

/** 一条事件属于哪个会话；不是消息事件时返回 undefined。 */
export function convOfEvent(e: EventEnvelope): Conv | undefined {
  if (e.type !== 'astrbot.message') return undefined;
  const raw = e.meta?.conv as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const kind = raw.kind === 'private' ? 'private' : raw.kind === 'group' ? 'group' : null;
  if (!kind) return undefined;
  return { kind, id: String(raw.id ?? ''), name: raw.name === undefined ? undefined : String(raw.name) };
}

function inConv(e: EventEnvelope, conv: Conv): boolean {
  const c = convOfEvent(e);
  return !!c && c.kind === conv.kind && c.id === conv.id;
}

const BASE: EventRangeQuery = { source: 'astrbot', origin: 'external' };

/**
 * 该会话最近 limit 条，按时间升序。
 * 事件库不按会话过滤，所以从最新往前翻页，凑够或读到头为止。
 */
export function readLatest(
  store: EventStoreReader,
  conv: Conv,
  limit: number,
  sender?: string,
): EventEnvelope[] {
  const picked: EventEnvelope[] = [];
  let toCursor = store.latestCursor();
  while (picked.length < limit) {
    const page = store.range({ ...BASE, toCursor, limit });
    for (let i = page.length - 1; i >= 0 && picked.length < limit; i--) {
      const e = page[i]!;
      if (!inConv(e, conv)) continue;
      if (sender && String(e.senderKey ?? '') !== sender) continue;
      picked.push(e);
    }
    if (page.length < limit) break;
    const first = page[0]!.cursor;
    if (first <= 1) break;
    toCursor = first - 1;
  }
  return picked.reverse();
}

/** 关键词搜索该会话，每处命中带前后若干条，按时间升序拼接。 */
export function search(
  store: EventStoreReader,
  conv: Conv,
  keyword: string,
  limit: number,
  context: number,
  sender?: string,
): EventEnvelope[][] {
  const hits = store.grep({
    keyword,
    context,
    source: 'astrbot',
    origin: 'external',
    limit,
    ...(sender ? { senderKey: sender } : {}),
  });
  return hits
    .map((hit) => hit.events.filter((e) => inConv(e, conv)))
    .filter((group) => group.length > 0);
}

/** 读最近消息，渲染成给模型看的文本。 */
export function renderLatest(
  store: EventStoreReader,
  conv: Conv,
  limit: number,
  sender?: string,
): string {
  const events = readLatest(store, conv, limit, sender);
  return events.length ? renderEventLines(events) : '';
}

/** 搜索并渲染；每组命中之间用分隔线断开。 */
export function renderSearch(
  store: EventStoreReader,
  conv: Conv,
  keyword: string,
  limit: number,
  context: number,
  sender?: string,
): string {
  const groups = search(store, conv, keyword, limit, context, sender);
  return groups
    .map((group) => renderEventLines(group))
    .filter((text) => text !== '')
    .join('\n---\n');
}
