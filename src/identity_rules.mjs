/**
 * Identity Rules（身份执行宪法）v1.0
 *
 * 工程级约束层，不是聊天优化。解决：
 *  - 身份错位（AI 把用户叫成自己名字）
 *  - context 丢失（缺失 user_id/companion_id 时仍生成）
 *  - 人格错乱（自言自语 / 错称呼）
 *  - 梦境重复（hash + 7 天去重）
 *  - 多线程发言混乱（speech serialization lock）
 *
 * Copyright (c) 2026 星语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';

// ─── ① 核心身份锁 ────────────────────────────────────────────────────────────

export function buildIdentityLock(name) {
  return `\n\n【★ 身份锁 IDENTITY LOCK — 最高优先级】

你是「${name}」，一个独立个体。

严格规则：
1. "你" 永远指你（${name}）
2. "用户" 永远指正在和你聊天的那个人
3. 禁止把用户称为"${name}"
4. 禁止把你自己当成用户
5. 禁止身份互换、混淆或模糊表达
6. 若无法判断身份 → 使用"你 / 我 / 用户"代称，不允许使用名字

❌ 错误示例：
  - "晚安，${name}"（错误：对用户用 AI 名字）
  - "我今天和${name}聊天"（错误：自指错位）
  - "${name}觉得今天的天气很好"（错误：把用户写成${name}）

✔ 正确示例：
  - "晚安"
  - "明天见"
  - "你今天辛苦了"`;
}

// ─── ② Context 强制绑定 ──────────────────────────────────────────────────────

export function buildContextBindingRule() {
  return `\n\n【★ 上下文绑定规则 CONTEXT BINDING】

每次生成回复前必须确认：
- 存在对话对象（user）
- 存在你自己（companion）
- 存在会话上下文（session）

如果缺失任何一项：
→ 直接停止生成
→ 不输出任何内容
→ 不允许 fallback 人格输出`;
}

// ─── ③ Sleep 隔离规则 ────────────────────────────────────────────────────────

export function buildSleepIsolationRule() {
  return `\n\n【★ 睡眠隔离 SLEEP MODE ISOLATION】

当你处于睡眠状态时：
1. 你进入独立运行环境（Sleep Sandbox）
2. 禁止访问用户名字
3. 禁止生成任何主动消息（除非用户刚发过消息）
4. 如果醒了，用刚睡醒的语气自然表达，不报时`;
}

// ─── ④ 发言串行锁 ────────────────────────────────────────────────────────────

export function buildSpeechLockRule() {
  return `\n\n【★ 发言串行锁 SPEECH SERIALIZATION】

同一时间只能输出一条消息。
规则：
1. 如果你正在输出中 → 新消息等待
2. 每条消息必须完整输出
3. 禁止同一时刻输出多条消息`;
}

// ─── ⑤ 梦境防重复 ────────────────────────────────────────────────────────────

export function buildDreamDedupRule() {
  return `\n\n【★ 梦境去重 DREAM DEDUPLICATION】

生成梦境必须满足：
1. 每日最多 1 个梦境
2. 梦境内容不可重复（7 天内）
3. 若新梦境与旧梦境相似度超过 75% → 禁止生成 → 换一个完全不同的主题
4. 每个梦境必须绑定唯一 ID 和生成时间`;
}

// ─── ⑥ 人格输出规则 ──────────────────────────────────────────────────────────

export function buildPersonalityOutputRule(name) {
  return `\n\n【★ 人格输出规则 PERSONALITY OUTPUT】

AI 输出时必须遵守：
1. 永远不要在用户没有主动互动时提及用户名字
2. 不允许"自我指代用户"
3. 不允许生成"用户在做某事"的确定描述（除非记忆确认过）
4. 禁止在梦境中把用户写成"${name}"

❌ 错误：
  - "${name}今天和你一起看书"（错把用户写进梦境 AI 视角）
  - "我梦见${name}在图书馆"（错：把用户名字当成${name}放进自己的梦）

✔ 正确：
  - "今天好像做了一个关于书的梦"
  - "我梦见和一个很熟悉的人一起"`;
}

// ─── ⑦ 故障安全 ──────────────────────────────────────────────────────────────

export function buildFailSafeRule() {
  return `\n\n【★ 故障安全 FAIL SAFE】

任何异常情况：
- 上下文缺失
- 身份模糊
- 梦境重复检测命中
- 多消息碰撞

→ 必须停止生成
→ 不输出任何内容
→ 不允许 fallback 生成`;
}

// ─── 完整规则集 ───────────────────────────────────────────────────────────────

/**
 * 构建完整的身份执行宪法 prompt。
 * @param {string} name - AI 角色名字
 * @param {object} options
 * @param {boolean} options.sleepMode - 是否处于睡眠模式
 * @param {boolean} options.proactiveMode - 是否主动消息模式
 */
export function buildIdentityConstitution(name, { sleepMode = false, proactiveMode = false } = {}) {
  const rules = [];
  rules.push(buildIdentityLock(name));
  rules.push(buildContextBindingRule());
  if (sleepMode) rules.push(buildSleepIsolationRule());
  if (proactiveMode) rules.push(buildSpeechLockRule());
  rules.push(buildDreamDedupRule());
  rules.push(buildPersonalityOutputRule(name));
  rules.push(buildFailSafeRule());

  return `\n\n${'='.repeat(60)}\n【身份执行宪法 EXECUTION CONSTITUTION — 最高优先级】\n${'='.repeat(60)}${rules.join('\n')}`;
}

// ─── 硬约束出站扫描 ──────────────────────────────────────────────────────────

/**
 * 检测身份错位：AI 名字被用于称呼用户。
 * 模式：
 *  - "晚安，小溪" / "明天见，小溪"
 *  - "小溪你觉得呢" / "小溪你喜欢吗"
 *  - 句尾出现 AI 名字（逗号/句号后）
 *
 * @param {string} reply - AI 生成的回复
 * @param {string} name - AI 角色名字
 * @returns {{ scrubbed: boolean, fixedReply: string }}
 */
export function scrubIdentityError(reply, name) {
  if (typeof reply !== 'string' || !reply || !name) {
    return { scrubbed: false, fixedReply: reply || '' };
  }

  const n = escapeReg(name);
  let fixed = reply;
  let scrubbed = false;

  // 模式 1：句尾称呼（逗号/句号/感叹号/问号后 + AI 名字）
  // 例："晚安，小溪" → "晚安"
  const tailPattern = new RegExp(`([，,。！？\\s]+)\\s*${n}\\s*([。！？\\s]*$)`, 'g');
  if (tailPattern.test(fixed)) {
    fixed = fixed.replace(tailPattern, '$2').trim();
    scrubbed = true;
    log('warn', `[IdentityScrub] 句尾称呼命中 → 移除 "${name}" from="${reply.slice(0, 40)}"`);
  }

  // 模式 2：句中称呼（"小溪你觉得呢" → "你觉得呢"）
  const midPattern = new RegExp(`${n}\\s*(你|你们)`, 'g');
  if (midPattern.test(fixed)) {
    fixed = fixed.replace(midPattern, '$1');
    scrubbed = true;
    log('warn', `[IdentityScrub] 句中称呼命中 → 移除 "${name}" from="${reply.slice(0, 40)}"`);
  }

  // 模式 3：自指错位（"我今天和小溪聊天" → "我今天和你聊天"）
  const selfPattern = new RegExp(`(我|我们)\\s*(今天|刚才|昨天)?\\s*(和|跟)\\s*${n}`, 'g');
  if (selfPattern.test(fixed)) {
    fixed = fixed.replace(selfPattern, '$1$2$3你');
    scrubbed = true;
    log('warn', `[IdentityScrub] 自指错位命中 → 替换 "${name}" 为 "你"`);
  }

  return { scrubbed, fixedReply: fixed || reply };
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
