/**
 * Event Memory（事件记忆系统）v1.0
 *
 * 防止 AI 在主动消息中反复提及同一事件。
 *
 * 核心机制：
 *  - 事件唯一 ID（dream_20260612_001）
 *  - 事件写入 DB，追踪 mentionedCount
 *  - 主动消息前检查 72h 内事件：mentionedCount > 0 → 禁止
 *  - Topic Dedup（48h 主题去重 + 相似度检测）
 *  - 冷却时间：Dream 24h / Movie 12h / Life 6h
 *
 * Copyright (c) 2026 星语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import {
  insertEventMemory, markEventMentioned, getRecentEvents, getUnmentionedEvents,
  insertTopicLog, getRecentTopics,
  shanghaiDateKey,
} from './db.mjs';
import { isSemanticallySimilar, normalizeForSim, jaccard, ngramSet } from './text_similarity.mjs';

// ─── 冷却时间配置 ────────────────────────────────────────────────────────────
const COOLDOWN_MS = {
  dream:  24 * 3600_000,  // 梦境：24 小时
  movie:  12 * 3600_000,  // 影视：12 小时
  life:    6 * 3600_000,  // 生活：6 小时
  meet:    3 * 3600_000,  // 偶遇/碰见：3 小时
  event:   6 * 3600_000,  // 随机事件：6 小时
  milestone: 24 * 3600_000, // 里程碑：24 小时（同 dream）
};

// ─── 事件 ID 生成 ────────────────────────────────────────────────────────────

let _idCounters = {};

/**
 * 生成唯一事件 ID：{type}_{YYYYMMDD}_{序号}
 * 同一天同类事件递增序号。
 */
export function generateEventId(companionId, type) {
  const dateKey = shanghaiDateKey();
  const prefix = `${type}_${dateKey.replace(/-/g, '')}`;
  const counterKey = `${companionId}_${prefix}`;
  _idCounters[counterKey] = (_idCounters[counterKey] || 0) + 1;
  return `${prefix}_${String(_idCounters[counterKey]).padStart(3, '0')}`;
}

// ─── 事件记录 ────────────────────────────────────────────────────────────────

/**
 * 记录一个新事件到 event_memory 表。
 * 返回 eventId 或 null。
 */
export function recordEvent(companionId, type, summary) {
  const eventId = generateEventId(companionId, type);
  const ok = insertEventMemory(companionId, {
    id: eventId,
    type,
    summary,
    createdAt: Date.now(),
  });
  if (ok) {
    log('info', `[EventMemory] recorded id=${eventId} companion=${companionId} type=${type} summary="${summary}"`);
  }
  return ok ? eventId : null;
}

// ─── 标记已提及 ──────────────────────────────────────────────────────────────

/**
 * 标记事件已在主动消息中提及。
 */
export function markMentioned(eventId) {
  markEventMentioned(eventId);
}

// ─── 冷却检查 ────────────────────────────────────────────────────────────────

/**
 * 检查某类型事件是否还在冷却期内。
 * @returns {{ cooling: boolean, remainingMinutes: number }}
 */
export function checkCooldown(companionId, type) {
  const cooldownMs = COOLDOWN_MS[type] || 6 * 3600_000;
  const events = getRecentEvents(companionId, Math.ceil(cooldownMs / 3600_000));
  const recent = events.filter(e => e.type === type);
  if (recent.length === 0) return { cooling: false, remainingMinutes: 0 };

  const newest = recent[0]; // 按 created_at DESC 排序
  const elapsed = Date.now() - newest.created_at;
  if (elapsed < cooldownMs) {
    return {
      cooling: true,
      remainingMinutes: Math.ceil((cooldownMs - elapsed) / 60_000),
      lastEvent: newest,
    };
  }
  return { cooling: false, remainingMinutes: 0 };
}

// ─── 可提及事件候选 ─────────────────────────────────────────────────────────

/**
 * 获取 72 小时内未被提及且不在冷却期内的事件。
 * 按 createdAt DESC 排序。
 */
export function getAvailableEvents(companionId) {
  const unmentioned = getUnmentionedEvents(companionId, 72);
  const now = Date.now();
  return unmentioned.filter(e => {
    const cooldownMs = COOLDOWN_MS[e.type] || 6 * 3600_000;
    return (now - e.created_at) >= cooldownMs;
  });
}

// ─── 构建"已提及事件"prompt 提示 ────────────────────────────────────────────

/**
 * 构建「禁止重复提及的事件列表」prompt 片段。
 */
export function buildMentionedEventsHint(companionId) {
  const events = getRecentEvents(companionId, 72);
  const mentioned = events.filter(e => e.mentioned_count > 0);
  if (mentioned.length === 0) return '';

  const lines = mentioned.map(e =>
    `- ${e.type === 'dream' ? '梦见' : ''}${e.summary}（已主动提起 ${e.mentioned_count} 次）`
  );
  return `\n\n【★ 已提过的事件（严禁再主动提起）】\n${lines.join('\n')}\n这些事件你已经主动跟他说过了，**严格禁止**再次主动提起。他可以主动来问，但你不能主动重提。`;
}

// ─── 冷却提示 prompt ─────────────────────────────────────────────────────────

/**
 * 构建冷却期提示，告诉 AI 哪些类型事件不能提。
 */
export function buildCooldownHint(companionId) {
  const events = getRecentEvents(companionId, 48);
  const now = Date.now();
  const cooling = [];
  for (const e of events) {
    const cd = COOLDOWN_MS[e.type] || 6 * 3600_000;
    if (now - e.created_at < cd) {
      const mins = Math.ceil((cd - (now - e.created_at)) / 60_000);
      cooling.push(`${e.type === 'dream' ? '梦境' : e.type}（冷却中还剩 ${mins} 分钟）`);
    }
  }
  if (cooling.length === 0) return '';

  const unique = [...new Set(cooling)].slice(0, 5);
  return `\n\n【事件冷却中】以下类型事件还在冷却期，禁止生成：${unique.join('、')}`;
}

// ─── Topic Deduplication ─────────────────────────────────────────────────────

/**
 * 从文本中提取主题关键词。
 * 极简方法：按常见中文分隔符断句 + 去停用词，挑出实词片段。
 */
function extractTopics(text) {
  if (!text || typeof text !== 'string') return [];
  const cleaned = text
    .replace(/\|\|/g, ' ')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[，。！？、；：""''（）…\s]+/g, '|')
    .trim();
  const chunks = cleaned.split('|').filter(Boolean);
  const stopWords = new Set([
    '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们',
    '是', '的', '了', '在', '有', '和', '也', '就', '都', '不',
    '很', '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '哈', '嘿',
    '这', '那', '什么', '怎么', '哪里', '哪个', '刚才', '突然',
    '今天', '昨天', '明天', '现在', '最近', '一下', '有点', '感觉',
    '好', '想', '要', '去', '来', '做', '说', '看', '知道',
    '一个', '真的', '好像', '觉得', '就是', '没有', '还是', '可以',
    '刚', '还', '会', '没', '又', '都', '太', '个', '给',
  ]);
  const topics = new Set();
  for (const chunk of chunks) {
    const words = chunk.split(/(?<=[\u4e00-\u9fff])/);
    let acc = '';
    for (const w of words) {
      if (stopWords.has(w)) {
        if (acc.length >= 2) { topics.add(acc); acc = ''; }
        continue;
      }
      acc += w;
      if (acc.length >= 4) { topics.add(acc); acc = ''; }
    }
    if (acc.length >= 2) topics.add(acc);
  }
  return [...topics];
}

/**
 * 两条文本的主题相似度（用于 Topic Dedup）。
 * 提取主题关键词后用 bigram Jaccard 比较。
 */
function topicSimilarity(textA, textB) {
  const topicsA = extractTopics(textA).join('');
  const topicsB = extractTopics(textB).join('');
  const a = normalizeForSim(topicsA);
  const b = normalizeForSim(topicsB);
  if (a.length < 4 || b.length < 4) return 0;
  return jaccard(ngramSet(a, 2), ngramSet(b, 2));
}

/**
 * 检查新消息主题是否与近期话题重复。
 * @returns {{ duplicate: boolean, sim: number, matchedTopic: string|null }}
 */
export function checkTopicDuplicate(companionId, text) {
  const recentTopics = getRecentTopics(companionId, 48);
  if (recentTopics.length === 0) return { duplicate: false, sim: 0, matchedTopic: null };

  let bestSim = 0;
  let bestTopic = null;
  for (const topic of recentTopics) {
    const sim = topicSimilarity(text, topic);
    if (sim > bestSim) { bestSim = sim; bestTopic = topic; }
  }

  const isDup = bestSim >= 0.70;
  if (isDup) {
    log('info', `[EventMemory] TopicDedup hit companion=${companionId} sim=${bestSim.toFixed(2)} matched="${bestTopic?.slice(0, 30)}"`);
  }
  return { duplicate: isDup, sim: bestSim, matchedTopic: bestTopic };
}

/**
 * 记录一条话题到 topic_log。
 */
export function logTopic(companionId, text) {
  const topics = extractTopics(text);
  const topic = topics.join(' ').slice(0, 80) || text.slice(0, 80);
  if (topic) insertTopicLog(companionId, topic);
}

// ─── Prompt 禁止规则 ─────────────────────────────────────────────────────────

/**
 * 构建 Event Memory 完整的 prompt 禁止规则片段。
 * 在 sendProactiveMessage 的 systemPrompt 末尾追加。
 */
export function buildEventMemoryPromptHint(companionId) {
  const mentionedHint = buildMentionedEventsHint(companionId);
  const cooldownHint = buildCooldownHint(companionId);

  const rules = [
    '【★ Event Memory 规则】',
    '- 禁止重复已经主动提及过的事件。同一个事件只能主动提一次。',
    '- 禁止连续数小时围绕同一个梦境/话题展开。',
    '- 优先生成新的生活事件：吃饭、做手工、看动漫、听音乐、天气、朋友、学习、工作等。',
    '- 如果梦境已经分享过，禁止再次主动提起。',
    '- 如果最近几小时内已经聊过某个话题，禁止重复。',
  ];

  return rules.join('\n') + mentionedHint + cooldownHint;
}