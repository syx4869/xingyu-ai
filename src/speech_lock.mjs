/**
 * Speech Serialization Lock（发言串行锁）v1.0
 *
 * 防止同一 AI 同时输出多条消息。
 * 同一 companionId 同时只能有一个发言进行中。
 *
 * Copyright (c) 2026 星语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';

const locks = new Map();  // companionId → { lockedAt: number }

/** 尝试获取发言锁。返回 true 表示获取成功 */
export function tryAcquireSpeechLock(companionId) {
  if (!companionId) return false;
  const existing = locks.get(companionId);
  if (existing) {
    const elapsed = Date.now() - existing.lockedAt;
    // 超时 60s 自动释放（防止死锁）
    if (elapsed > 60_000) {
      locks.delete(companionId);
      log('warn', `[SpeechLock] 超时释放 companion=${companionId} elapsed=${elapsed}ms`);
    } else {
      log('info', `[SpeechLock] 被占用 companion=${companionId} elapsed=${elapsed}ms`);
      return false;
    }
  }
  locks.set(companionId, { lockedAt: Date.now() });
  return true;
}

/** 释放发言锁 */
export function releaseSpeechLock(companionId) {
  if (!companionId) return;
  locks.delete(companionId);
}

/** 检查是否正在发言 */
export function isSpeaking(companionId) {
  if (!companionId) return false;
  const existing = locks.get(companionId);
  if (!existing) return false;
  if (Date.now() - existing.lockedAt > 60_000) {
    locks.delete(companionId);
    return false;
  }
  return true;
}
