/**
 * Event Memory（事件记忆系统）v2.0
 *
 * 防重复 + 事件生命周期状态机 + 幂等执行。
 *
 * 核心机制：
 *  - 事件唯一 ID（dream_20260612_001）
 *  - 事件生命周期：CREATED → PLANNED → GENERATED → SENT → ACKNOWLEDGED → CLOSED
 *  - 内容哈希去重（event_hash）
 *  - 执行锁（execution_lock）— 幂等 guard
 *  - Topic Dedup（48h 主题去重 + 相似度检测）
 *  - 冷却时间：Dream 24h / Movie 12h / Life 6h
 *
 * Copyright (c) 2026 星语 AI Contributors. MIT License.
 */

import { createHash } from 'node:crypto';
import { log } from './logger.mjs';
import {
  insertEventMemory, insertEventMemoryV2, markEventMentioned, getRecentEvents, getUnmentionedEvents,
  insertTopicLog, getRecentTopics,
  shanghaiDateKey,
  getEventByHash, transitionEventState, acquireEventLock, releaseEventLock, getRecentEventsByState,
} from './db.mjs';
import { isSemanticallySimilar, normalizeForSim, jaccard, ngramSet } from './text_similarity.mjs';

// ─── 事件生命周期状态 ─────────────────────────────────────────────────────────
export const EVENT_STATES = {
  CREATED:      'CREATED',
  PLANNED:      'PLANNED',
  GENERATED:    'GENERATED',
  SENT:         'SENT',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  CLOSED:       'CLOSED',
};

// 合法状态流转
const VALID_TRANSITIONS = {
  [EVENT_STATES.CREATED]:      [EVENT_STATES.PLANNED, EVENT_STATES.GENERATED],
  [EVENT_STATES.PLANNED]:      [EVENT_STATES.GENERATED],
  [EVENT_STATES.GENERATED]:    [EVENT_STATES.SENT, EVENT_STATES.CLOSED],
  [EVENT_STATES.SENT]:         [EVENT_STATES.ACKNOWLEDGED, EVENT_STATES.CLOSED],
  [EVENT_STATES.ACKNOWLEDGED]: [EVENT_STATES.CLOSED],
  [EVENT_STATES.CLOSED]:       [],
};

// 终态集合（不可再执行）
const TERMINAL_STATES = new Set([EVENT_STATES.CLOSED, EVENT_STATES.ACKNOWLEDGED]);

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
 */
export function generateEventId(companionId, type) {
  const dateKey = shanghaiDateKey();
  const prefix = `${type}_${dateKey.replace(/-/g, '')}`;
  const counterKey = `${companionId}_${prefix}`;
  _idCounters[counterKey] = (_idCounters[counterKey] || 0) + 1;
  return `${prefix}_${String(_idCounters[counterKey]).padStart(3, '0')}`;
}

// ─── 内容哈希（幂等键） ──────────────────────────────────────────────────────

/**
 * 基于事件内容生成幂等哈希。
 * 相同 companionId + type + 核心内容 → 相同 hash。
 */
export function eventHash(companionId, type, summary) {
  const raw = `${companionId}|${type}|${String(summary).trim()}`;
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

// ─── 幂等 guard ──────────────────────────────────────────────────────────────

/**
 * 检查事件是否已存在（通过 hash），已存在则返回现有记录。
 * 这是生成前的第一道防线。
 */
export function findExistingEvent(companionId, type, summary) {
  const hash = eventHash(companionId, type, summary);
  return getEventByHash(companionId, hash) || null;
}

/**
 * 检查事件是否处于终态（不可再执行）。
 */
export function isEventTerminal(event) {
  if (!event) return false;
  return TERMINAL_STATES.has(event.event_state);
}

/**
 * 检查事件是否可执行（非终态 + 锁未持有）。
 */
export function isEventExecutable(eventId) {
  if (!eventId) return false;
  try {
    const events = getRecentEvents(0, 168); // 宽范围查询
    const found = events.find(e => e.id === eventId);
    if (!found) return true; // 不存在则允许（可能已过期）
    return !TERMINAL_STATES.has(found.event_state) && !found.execution_lock;
  } catch { return true; }
}

// ─── 事件记录（v2.0：带 hash + state） ────────────────────────────────────────

/**
 * 记录一个新事件到 event_memory 表。
 * v2.0: 写入 event_hash + event_state='CREATED'。
 * 若 hash 已存在则返回现有 eventId（幂等）。
 * @param {string} [eventId] 可选，不传则自动生成
 * 返回 eventId 或 null。
 */
export function recordEvent(companionId, type, summary, eventId = null) {
  const hash = eventHash(companionId, type, summary);

  // 幂等检查：相同 hash 已存在 → 返回现有 ID
  const existing = getEventByHash(companionId, hash);
  if (existing) {
    log('info', `[EventMemory] 幂等命中 id=${existing.id} hash=${hash} — 不重复创建`);
    return existing.id;
  }

  const id = eventId || generateEventId(companionId, type);
  const ok = insertEventMemoryV2(companionId, {
    id,
    type,
    summary,
    eventHash: hash,
    createdAt: Date.now(),
  });
  if (ok) {
    log('info', `[EventMemory] recorded id=${id} companion=${companionId} type=${type} state=CREATED hash=${hash}`);
  }
  return ok ? id : null;
}

// ─── 状态流转 ────────────────────────────────────────────────────────────────

/**
 * 安全状态流转。非法流转返回 false。
 */
export function transition(eventId, newState) {
  if (!eventId || !newState) return false;
  // 获取当前状态
  const events = getRecentEvents(0, 168);
  const current = events.find(e => e.id === eventId);
  if (!current) {
    // 不存在则直接写
    transitionEventState(eventId, newState);
    return true;
  }
  const curState = current.event_state || EVENT_STATES.CREATED;
  const valid = VALID_TRANSITIONS[curState] || [];
  if (!valid.includes(newState)) {
    log('warn', `[EventMemory] 非法状态流转 id=${eventId} ${curState} → ${newState}（拒绝）`);
    return false;
  }
  transitionEventState(eventId, newState);
  log('info', `[EventMemory] 状态流转 id=${eventId} ${curState} → ${newState}`);
  return true;
}

// 便捷流转函数
export const planEvent       = (id) => transition(id, EVENT_STATES.PLANNED);
export const markGenerated   = (id) => transition(id, EVENT_STATES.GENERATED);
export const markSent        = (id) => transition(id, EVENT_STATES.SENT);
export const markAcknowledged= (id) => transition(id, EVENT_STATES.ACKNOWLEDGED);
export const closeEvent      = (id) => transition(id, EVENT_STATES.CLOSED);

/**
 * 用户回复主动消息时，将最近一条 SENT 事件流转为 ACKNOWLEDGED。
 */
export function acknowledgeRecentSent(companionId) {
  const sentEvents = getRecentEventsByState(companionId, EVENT_STATES.SENT, 48);
  if (sentEvents.length === 0) return;
  const latest = sentEvents[0];
  markAcknowledged(latest.id);
  log('info', `[EventMemory] 用户回复确认 id=${latest.id} SENT → ACKNOWLEDGED`);
}

// ─── 执行锁（幂等执行） ──────────────────────────────────────────────────────

/**
 * 尝试获取执行锁。返回 true 表示获取成功，可以执行。
 * 调用方执行完毕后必须调用 releaseExecLock。
 */
export function tryAcquireExecLock(eventId) {
  if (!eventId) return false;
  const ok = acquireEventLock(eventId);
  if (ok) {
    log('info', `[EventMemory] 执行锁获取 id=${eventId}`);
  }
  return ok;
}

/**
 * 释放执行锁。
 */
export function releaseExecLock(eventId) {
  if (!eventId) return;
  releaseEventLock(eventId);
}

// ─── 标记已提及 ──────────────────────────────────────────────────────────────

/**
 * 标记事件已在主动消息中提及。
 * v2.0: 同时流转 SENT。
 */
export function markMentioned(eventId) {
  markEventMentioned(eventId);
  markSent(eventId);  // v2.0: 自动流转
}

// ─── 冷却检查（v2.0: 排除终态事件） ──────────────────────────────────────────

/**
 * 检查某类型事件是否还在冷却期内。
 * v2.0: 终态事件不计入冷却。
 */
export function checkCooldown(companionId, type) {
  const cooldownMs = COOLDOWN_MS[type] || 6 * 3600_000;
  const events = getRecentEvents(companionId, Math.ceil(cooldownMs / 3600_000));
  const recent = events.filter(e => e.type === type && !TERMINAL_STATES.has(e.event_state));
  if (recent.length === 0) return { cooling: false, remainingMinutes: 0 };

  const newest = recent[0];
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

export function getAvailableEvents(companionId) {
  const unmentioned = getUnmentionedEvents(companionId, 72);
  const now = Date.now();
  return unmentioned.filter(e => {
    if (TERMINAL_STATES.has(e.event_state)) return false;
    const cooldownMs = COOLDOWN_MS[e.type] || 6 * 3600_000;
    return (now - e.created_at) >= cooldownMs;
  });
}

// ─── 梦境专用 ────────────────────────────────────────────────────────────────

export function getRecentDreamEvent(companionId) {
  const events = getRecentEvents(companionId, 48);
  return events.find(e => e.type === 'dream' && !TERMINAL_STATES.has(e.event_state)) || null;
}

export function isDreamGenerationAllowed(companionId) {
  const dream = getRecentDreamEvent(companionId);
  if (!dream) return { allowed: true, reason: '' };

  const elapsed = Date.now() - dream.created_at;
  if (elapsed < COOLDOWN_MS.dream) {
    return {
      allowed: false,
      reason: `24h 冷却中（${Math.ceil((COOLDOWN_MS.dream - elapsed) / 3600_000)}h 后解禁）`,
      lastDream: dream,
    };
  }
  if (dream.mentioned_count > 0) {
    return { allowed: false, reason: '梦境已分享过', lastDream: dream };
  }
  return { allowed: true, reason: '' };
}

/**
 * 检查新梦境主题是否与 7 天内任何梦境相似度 > 0.75。
 * 用于阻止生成相似主题的梦境。
 */
export function isDreamSimilarToRecent(companionId, newTheme) {
  const events = getRecentEvents(companionId, 168); // 7 天
  const recentDreams = events.filter(e => e.type === 'dream');
  if (recentDreams.length === 0) return false;

  for (const dream of recentDreams) {
    const sim = topicSimilarity(newTheme, dream.summary || '');
    if (sim >= 0.75) {
      log('info', `[EventMemory] 梦境相似度命中 sim=${sim.toFixed(2)} new="${newTheme}" old="${dream.summary?.slice(0, 30)}"`);
      return true;
    }
  }
  return false;
}

// ─── 构建"已提及事件"prompt 提示 ────────────────────────────────────────────

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

export function buildCooldownHint(companionId) {
  const events = getRecentEvents(companionId, 48);
  const now = Date.now();
  const cooling = [];
  for (const e of events) {
    if (TERMINAL_STATES.has(e.event_state)) continue;
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

function topicSimilarity(textA, textB) {
  const topicsA = extractTopics(textA).join('');
  const topicsB = extractTopics(textB).join('');
  const a = normalizeForSim(topicsA);
  const b = normalizeForSim(topicsB);
  if (a.length < 4 || b.length < 4) return 0;
  return jaccard(ngramSet(a, 2), ngramSet(b, 2));
}

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

export function logTopic(companionId, text) {
  const topics = extractTopics(text);
  const topic = topics.join(' ').slice(0, 80) || text.slice(0, 80);
  if (topic) insertTopicLog(companionId, topic);
}

// ─── Prompt 禁止规则 ─────────────────────────────────────────────────────────

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