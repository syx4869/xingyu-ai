/**
 * Timeline Engine（时间线引擎）v1.0
 *
 * 为 AI 角色记录重要人生事件，支持时间线回顾、回忆触发和跨系统联动。
 *
 * 联动：proactive.mjs / life_engine.mjs（梦境）/ emotion_state.mjs / memory
 *
 * Copyright (c) 2026 星语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { getDb, shanghaiDateKey } from './db.mjs';

// ─── DB 迁移 ──────────────────────────────────────────────────────────────────

export function migrateTimeline() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS companion_timeline (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      companion_id  INTEGER NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      date_key      TEXT NOT NULL,
      description   TEXT NOT NULL,
      category      TEXT NOT NULL DEFAULT 'general',
      participants  TEXT DEFAULT '[]',
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_companion ON companion_timeline(companion_id, date_key);
  `);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * 记录一条时间线事件。
 * @param {number} companionId
 * @param {string} dateKey - 日期键，如 '2026-06-01'
 * @param {string} description - 事件描述，如 '第一次认识用户'
 * @param {string} category - 分类：'first_meet' | 'milestone' | 'conflict' | 'reconcile' | 'general'
 * @param {string[]} [participants] - 参与角色
 * @returns {number|null} 插入的 id
 */
export function recordTimelineEvent(companionId, dateKey, description, category = 'general', participants = []) {
  try {
    const stmt = getDb().prepare(`
      INSERT INTO companion_timeline (companion_id, date_key, description, category, participants, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(companionId, dateKey, description, category, JSON.stringify(participants), Date.now());
    log('info', `[Timeline] recorded companion=${companionId} date=${dateKey} cat=${category} desc="${description}"`);
    return r.lastInsertRowid;
  } catch (e) {
    log('warn', `[Timeline] record failed companion=${companionId}: ${e.message}`);
    return null;
  }
}

/**
 * 获取时间线列表（最近 N 条）。
 */
export function getTimeline(companionId, limit = 20) {
  try {
    return getDb().prepare(`
      SELECT id, date_key, description, category, participants, created_at
      FROM companion_timeline
      WHERE companion_id = ?
      ORDER BY date_key DESC, id DESC
      LIMIT ?
    `).all(companionId, limit);
  } catch {
    return [];
  }
}

/**
 * 获取指定日期范围内的事件。
 */
export function getTimelineForPeriod(companionId, startDateKey, endDateKey) {
  try {
    return getDb().prepare(`
      SELECT id, date_key, description, category, participants, created_at
      FROM companion_timeline
      WHERE companion_id = ? AND date_key >= ? AND date_key <= ?
      ORDER BY date_key ASC
    `).all(companionId, startDateKey, endDateKey);
  } catch {
    return [];
  }
}

/**
 * 获取最近的一个里程碑事件（用于主动消息引用）。
 */
export function getRecentMilestone(companionId) {
  try {
    return getDb().prepare(`
      SELECT id, date_key, description, category, participants, created_at
      FROM companion_timeline
      WHERE companion_id = ? AND category IN ('first_meet', 'milestone', 'conflict', 'reconcile')
      ORDER BY date_key DESC
      LIMIT 1
    `).get(companionId);
  } catch {
    return null;
  }
}

/**
 * 生成时间线回忆 prompt 片段，用于主动消息/梦境/内心独白。
 * 返回 { text: '上个月你们一起看了动漫', events: [...] }
 */
export function generateTimelineRecall(companionId) {
  const events = getTimeline(companionId, 30);
  if (events.length === 0) return { text: '', events: [] };

  const today = new Date();
  const todayKey = shanghaiDateKey(today);

  const recallable = events.filter(e => {
    if (e.date_key === todayKey) return false;
    const days = daysBetween(e.date_key, todayKey);
    return days >= 7; // 至少 7 天前的事件才值得回忆
  }).slice(0, 5);

  if (recallable.length === 0) return { text: '', events: [] };

  const lines = recallable.map(e => {
    const days = daysBetween(e.date_key, todayKey);
    const ago = days <= 14 ? '两周前' : days <= 31 ? '上个月' : days <= 90 ? '几个月前' : '很久以前';
    return `${ago}${e.description}`;
  });

  return { text: `你们共同经历的时间线：${lines.join('；')}。`, events: recallable };
}

// ─── 自动记录里程碑 ───────────────────────────────────────────────────────────

/**
 * 根据 companion 状态自动补录时间线事件（幂等，不重复）。
 */
export function autoRecordMilestones(companionId, companion) {
  const c = companion || getCompanionCel(companionId);
  if (!c) return;

  // 首次认识
  if (c.created_at) {
    const dateKey = toDateKey(c.created_at);
    upsertTimeline(companionId, dateKey, '第一次认识用户', 'first_meet');
  }

  // 首次聊天
  if (c.first_chat_at) {
    const dateKey = toDateKey(c.first_chat_at);
    upsertTimeline(companionId, dateKey, '第一次和用户聊天', 'milestone');
  }

  // AI 表白
  if (c.confessed_at) {
    const dateKey = toDateKey(c.confessed_at);
    upsertTimeline(companionId, dateKey, '向用户表白了', 'milestone');
  }

  // 用户表白
  if (c.user_confessed_at) {
    const dateKey = toDateKey(c.user_confessed_at);
    upsertTimeline(companionId, dateKey, '用户向我表白了', 'milestone');
  }
}

// ─── 内部工具 ──────────────────────────────────────────────────────────────────

function getCompanionCel(companionId) {
  try {
    return getDb().prepare('SELECT id, created_at, first_chat_at, confessed_at, user_confessed_at FROM companions WHERE id = ?').get(companionId);
  } catch { return null; }
}

function toDateKey(dt) {
  const d = new Date(typeof dt === 'string' ? dt.replace(' ', 'T') + 'Z' : dt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(dateKeyA, dateKeyB) {
  const a = new Date(dateKeyA);
  const b = new Date(dateKeyB);
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function upsertTimeline(companionId, dateKey, description, category) {
  const exists = getDb().prepare(`
    SELECT id FROM companion_timeline
    WHERE companion_id = ? AND date_key = ? AND description = ?
  `).get(companionId, dateKey, description);
  if (!exists) {
    recordTimelineEvent(companionId, dateKey, description, category);
  }
}