const LABEL = {
  plain: '文字', image: '图片', record: '语音', video: '视频', file: '文件',
  face: '表情', at: '提及', node: '转发条目', nodes: '合并转发', poke: '戳一戳',
  reply: '引用', forward: '合并转发', rps: '猜拳', dice: '骰子', shake: '抖动',
  share: '链接分享', contact: '联系人分享', location: '位置', music: '音乐',
  json: '卡片', unknown: '未知组件',
} as const;

const FIELDS = [
  'text', 'id', 'sender', 'name', 'time', 'kind', 'result', 'target', 'size',
  'width', 'height', 'duration', 'summary', 'slot', 'title', 'url', 'lat',
  'lon', 'app', 'forward_id', 'attachment', 'media_state',
] as const;

type Kind = keyof typeof LABEL;

export interface MessageSegment {
  type: Kind;
  fields: Partial<Record<(typeof FIELDS)[number], string>>;
  children?: MessageSegment[];
  truncated?: boolean;
}

export function parseSegments(raw: unknown): MessageSegment[] {
  let remaining = 120;
  function visit(list: unknown, depth: number): MessageSegment[] {
    if (!Array.isArray(list) || depth > 5) return [];
    const out: MessageSegment[] = [];
    for (const item of list) {
      if (remaining-- <= 0) break;
      if (!item || typeof item !== 'object' || typeof item.type !== 'string') continue;
      const type = Object.hasOwn(LABEL, item.type) ? item.type as Kind : 'unknown';
      const fields: MessageSegment['fields'] = {};
      if (item.fields && typeof item.fields === 'object') {
        for (const key of FIELDS) {
          const value = item.fields[key];
          if (typeof value === 'string' && value) {
            fields[key] = value.slice(0, key === 'text' ? 1600 : 320);
          }
        }
      }
      const children = visit(item.children, depth + 1);
      const truncated = item.truncated === true ||
        (Array.isArray(item.children) && children.length < item.children.length);
      out.push({
        type,
        fields,
        ...(children.length ? { children } : {}),
        ...(truncated ? { truncated } : {}),
      });
    }
    return out;
  }
  return visit(raw, 0);
}

function isForward(segment: MessageSegment): boolean {
  return segment.type === 'forward' || (segment.type === 'json' && !!segment.fields.forward_id);
}

export function needsBridge(segment: MessageSegment): boolean {
  return !segment.children?.length && (
    (isForward(segment) && !!(segment.fields.id || segment.fields.forward_id)) || (
      (segment.type === 'image' || segment.type === 'record') && segment.fields.media_state === 'deferred'
    )
  );
}

const trim = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

export function imageAttachmentIndex(segment: MessageSegment): number | undefined {
  const index = segment.fields.attachment;
  return segment.type === 'image' && index && /^(0|[1-9]\d*)$/.test(index)
    ? Number(index) : undefined;
}

function brief(segment: MessageSegment, index?: number): string {
  const { type, fields } = segment;
  if (type === 'plain') return fields.text ?? '';
  if (type === 'at') {
    if (fields.id === 'all') return '@全体成员';
    return fields.name ? `@${fields.name}(${fields.id ?? ''})` : `@${fields.id ?? '用户'}`;
  }
  if (type === 'image' && fields.text && fields.media_state !== 'deferred') return fields.text;
  if (type === 'record' && fields.text) return `[语音] ${fields.text}`;
  const position = index === undefined ? '' : ` · 组件 ${index}`;
  const label = isForward(segment) ? '合并转发' : LABEL[type];
  let detail = fields.title || fields.name || fields.result || fields.summary || fields.id || fields.kind || '';
  if (type === 'reply') {
    const isMedia = (child: MessageSegment) => child.type === 'image' || child.type === 'record';
    const text = fields.text || segment.children?.filter((child) => !isMedia(child)).map((child) => brief(child)).join(' ') || '';
    detail = [fields.name, text || (fields.id ? `#${fields.id}` : '')].filter(Boolean).join(' ');
    const media = segment.children?.filter(isMedia).map((child) => brief(child)).join(' ') || '';
    return `[${label}${position}] ${[trim(detail, 126), trim(media, 600)].filter(Boolean).join(' ')}`.trimEnd();
  }
  if (type === 'unknown') detail = [fields.kind, fields.text].filter(Boolean).join(' ');
  const value = fields.media_state === 'deferred' ? '可打开查看' : detail;
  return `[${label}${position}]${value ? ` ${trim(value.replace(/\s+/g, ' '), 126)}` : ''}`;
}

export function renderSegmentLine(segments: MessageSegment[]): string {
  return trim(segments.map((segment, index) => brief(segment, index + 1)).filter(Boolean).join(' '), 6000);
}

const DETAILS = {
  text: '内容', id: '编号', sender: '发送者 QQ', name: '名称', time: '时间',
  kind: '类型', result: '结果', target: '对象', size: '大小', width: '宽度',
  height: '高度', duration: '时长', summary: '摘要', title: '标题',
  url: '分享链接', lat: '纬度', lon: '经度', app: '应用',
} as const;

export function describeSegment(segment: MessageSegment): string {
  if (segment.type === 'plain') return segment.fields.text ?? '';
  const title = isForward(segment) ? '合并转发' : LABEL[segment.type];
  const details = Object.entries(DETAILS).flatMap(([key, label]) => {
    const value = segment.fields[key as keyof typeof DETAILS];
    return value ? [`${label}：${value}`] : [];
  });
  if (segment.truncated) details.push('部分内容超出读取上限。');
  if (isForward(segment) && !segment.children?.length && !segment.fields.id && !segment.fields.forward_id) {
    details.push('QQ 没有提供可展开内容。');
  }
  switch (segment.fields.media_state) {
    case 'described':
      details.push(segment.type === 'record' ? '已提供语音转写。' : '已提供图片转述。');
      break;
    case 'metadata':
      details.push('此组件提供资料信息。');
      break;
    case 'deferred':
      details.push('打开此组件可读取媒体。');
      break;
    case 'unavailable':
      if (!segment.fields.text || segment.fields.text === '[图片]') details.push('没有可读的媒体内容。');
      break;
    case 'disabled':
      details.push('媒体处理已关闭。');
      break;
  }
  return [title, ...details].join('\n');
}
