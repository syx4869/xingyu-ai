/**
 * Life Engine（生活模拟引擎）v2.0
 *
 * 让 AI 不再只是等待用户消息的聊天机器人，而是模拟一个拥有真实生活轨迹、
 * 作息规律、随机事件、个人习惯和自主行为的虚拟人物。
 *
 * 子系统：
 *  - 生活状态机（Sleep/Work/Rest/Entertainment/Exercise/Social/Meal/Travel）
 *  - 睡眠增强（梦境、半夜醒来、失眠）
 *  - 随机事件系统（噩梦、感冒、开心事件等）
 *  - 生活习惯系统（早睡早起/熬夜、喜好等）
 *  - 自主行为系统（分享日常、心情、音乐等）
 *
 * 联动：sleep.mjs / emotion_state.mjs / proactive.mjs / memory
 *
 * Copyright (c) 2026 星语 AI Contributors. MIT License.
 */

import { log } from './logger.mjs';
import { getDb, shanghaiDateKey } from './db.mjs';
import { getOrRefreshTodaySchedule, isSleepingNow, getSleepRow } from './sleep.mjs';
import { updateEmotionDimension } from './emotion_state.mjs';
import { generateReply } from './ai.mjs';
import { generateTimelineRecall } from './timeline.mjs';
import { recordEvent, checkCooldown, generateEventId, getRecentDreamEvent, isDreamGenerationAllowed, isDreamAlreadyShared, checkTopicDuplicate } from './event_memory.mjs';  // v2.1.1, v2.1.3

// ─── 状态机定义 ────────────────────────────────────────────────────────────────

export const LIFE_STATES = {
  SLEEP:        'sleep',
  WAKE_UP:      'waking_up',
  WORK:         'work',
  REST:         'rest',
  MEAL:         'meal',
  ENTERTAINMENT:'entertainment',
  EXERCISE:     'exercise',
  SOCIAL:       'social',
  TRAVEL:       'travel',
  IDLE:         'idle',
};

export const SLEEP_SUB_STATES = {
  DEEP:         'deep_sleep',
  LIGHT:        'light_sleep',
  DREAMING:     'dreaming',
  MIDNIGHT_AWAKE:'midnight_awake',
  INSOMNIA:     'insomnia',
};

// 默认作息时间表（上海时区，小时）
const DEFAULT_SCHEDULE = {
  wake:   7,
  work:   9,
  lunch:  12,
  dinner: 18,
  relax:  20,
  sleep:  23,
};

// 上海时区安全的小时/分钟获取（避免 getHours() 用服务器本地时间）
function getShanghaiHourMinute(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).filter(x => x.type !== 'literal').map(x => [x.type, x.value])
  );
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}

// 随机事件池
const RANDOM_EVENTS = [
  { id: 'nightmare',       category: 'sleep',  emotion: { fear: 15, sadness: 5 },  desc: '做噩梦了' },
  { id: 'midnight_wake',   category: 'sleep',  emotion: { energy: -5 },             desc: '半夜醒了' },
  { id: 'insomnia_trigger',category: 'sleep',  emotion: { sadness: 8, energy: -10 },desc: '失眠了' },
  { id: 'thirst',          category: 'sleep',  emotion: {},                          desc: '口渴起来喝水' },
  { id: 'bathroom',        category: 'sleep',  emotion: {},                          desc: '起夜上厕所' },
  { id: 'overslept',       category: 'morning',emotion: { energy: 5, mood: 'happy' },desc: '睡过头了但睡得很香' },
  { id: 'headache',        category: 'day',    emotion: { energy: -10, mood: 'tired' },desc: '有点头疼' },
  { id: 'cold',            category: 'day',    emotion: { energy: -15, mood: 'tired' },desc: '感冒了' },
  { id: 'happy_surprise',  category: 'day',    emotion: { happiness: 10, mood: 'happy' },desc: '遇到了开心的事' },
  { id: 'find_song',       category: 'day',    emotion: { happiness: 8 },           desc: '发现了一首好听的歌' },
  { id: 'find_anime',      category: 'day',    emotion: { happiness: 8 },           desc: '发现了一部好看的动漫' },
  { id: 'find_video',      category: 'day',    emotion: { happiness: 8 },           desc: '刷到一个有趣的视频' },
  { id: 'take_photo',      category: 'day',    emotion: { happiness: 6 },           desc: '拍了一张好看的照片' },
  { id: 'think_of_user',   category: 'day',    emotion: { affection: 5 },           desc: '突然想到了你' },
  { id: 'receive_gift',    category: 'day',    emotion: { happiness: 12, affection: 5 },desc: '收到了礼物' },
  { id: 'mood_low',        category: 'day',    emotion: { sadness: 8, energy: -5 },  desc: '心情有点低落' },
  { id: 'rain',            category: 'day',    emotion: { sadness: 3, energy: -3 },  desc: '下雨了，不想出门' },
];

// 梦境素材池
const DREAM_THEMES = [
  '一起去海边散步',
  '在咖啡馆偶遇',
  '一起看了一场烟花',
  '在游乐园里玩',
  '一起做饭',
  '在图书馆并肩看书',
  '一起爬山看日出',
  '在雨中撑伞',
  '一起坐摩天轮',
  '在公园里喂猫',
];

// ─── DB 操作 ───────────────────────────────────────────────────────────────────

function ensureLifeState(companionId) {
  const db = getDb();
  let row = db.prepare('SELECT * FROM companion_life_state WHERE companion_id = ?').get(companionId);
  if (!row) {
    db.prepare(`
      INSERT INTO companion_life_state (companion_id, state, sub_state, last_state_change, today_date)
      VALUES (?, ?, NULL, ?, ?)
    `).run(companionId, LIFE_STATES.IDLE, Date.now(), shanghaiDateKey(new Date()));
    row = db.prepare('SELECT * FROM companion_life_state WHERE companion_id = ?').get(companionId);
  }
  return row;
}

function updateLifeState(companionId, updates) {
  const db = getDb();
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  values.push(companionId);
  db.prepare(`UPDATE companion_life_state SET ${fields.join(', ')} WHERE companion_id = ?`).run(...values);
}

function ensureLifeHabits(companionId) {
  const db = getDb();
  let row = db.prepare('SELECT * FROM companion_life_habits WHERE companion_id = ?').get(companionId);
  if (!row) {
    // 从 companion 表读取 personality/hobbies 来初始化习惯
    const comp = db.prepare('SELECT personality_tags, hobbies FROM companions WHERE id = ?').get(companionId);
    let sleepType = 'normal';
    let drinkPref = 'water';
    let hobbyTags = '[]';
    if (comp) {
      try {
        const tags = JSON.parse(comp.personality_tags || '[]');
        const tagStr = Array.isArray(tags) ? tags.join('') : '';
        if (/熬夜|夜猫|晚睡/.test(tagStr)) sleepType = 'night_owl';
        else if (/早起|早睡/.test(tagStr)) sleepType = 'early_bird';
        if (/奶茶/.test(tagStr)) drinkPref = 'milk_tea';
        else if (/咖啡/.test(tagStr)) drinkPref = 'coffee';
        else if (/茶/.test(tagStr)) drinkPref = 'tea';
        const hobbies = JSON.parse(comp.hobbies || '[]');
        hobbyTags = JSON.stringify(Array.isArray(hobbies) ? hobbies : []);
      } catch {}
    }
    db.prepare(`
      INSERT INTO companion_life_habits (companion_id, sleep_type, drink_preference, hobby_tags)
      VALUES (?, ?, ?, ?)
    `).run(companionId, sleepType, drinkPref, hobbyTags);
    row = db.prepare('SELECT * FROM companion_life_habits WHERE companion_id = ?').get(companionId);
  }
  return row;
}

export function getLifeHabits(companionId) {
  return ensureLifeHabits(companionId);
}

function recordLifeEvent(companionId, eventId, description, emotionDelta = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO companion_life_events (companion_id, event_id, description, emotion_delta, created_at, date_key)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(companionId, eventId, description, emotionDelta ? JSON.stringify(emotionDelta) : null, Date.now(), shanghaiDateKey(new Date()));
}

function recordDream(companionId, content, source) {
  const db = getDb();
  db.prepare(`
    INSERT INTO companion_dreams (companion_id, content, source, dream_date, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(companionId, content, source ? JSON.stringify(source) : null, shanghaiDateKey(new Date()), Date.now());
}

export function getLastDream(companionId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM companion_dreams WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(companionId);
}

export function getTodaysEvents(companionId) {
  const db = getDb();
  const todayKey = shanghaiDateKey(new Date());
  return db.prepare(`
    SELECT * FROM companion_life_events WHERE companion_id = ? AND date_key = ? ORDER BY created_at ASC
  `).all(companionId, todayKey);
}

export function getLifeStatus(companionId) {
  const state = ensureLifeState(companionId);
  const habits = ensureLifeHabits(companionId);
  const events = getTodaysEvents(companionId);
  const lastDream = getLastDream(companionId);
  return { state, habits, events, lastDream };
}

// ─── 状态机逻辑 ────────────────────────────────────────────────────────────────

/**
 * 每分钟 tick：根据当前时间和状态，决定是否切换状态。
 * @returns {{ changed: boolean, newState?: string, event?: object }}
 */
export function lifeTick(companionId, now = new Date()) {
  const state = ensureLifeState(companionId);
  const habits = ensureLifeHabits(companionId);
  const shanghai = getShanghaiHourMinute(now);
  const hour = shanghai.hour;
  const minute = shanghai.minute;
  const todayKey = shanghaiDateKey(now);

  // 重置每日状态
  if (state.today_date !== todayKey) {
    updateLifeState(companionId, { today_date: todayKey, todays_events_count: 0 });
    state.today_date = todayKey;
    state.todays_events_count = 0;
  }

  // 检查是否在睡眠中（复用 sleep.mjs 的睡眠窗口）
  const sleeping = isSleepingNow(companionId, now.getTime());
  if (sleeping) {
    return handleSleepTick(companionId, state, habits, hour, minute, now);
  }

  // 醒着：根据时间切换生活状态
  return handleAwakeTick(companionId, state, habits, hour, minute, now);
}

function handleSleepTick(companionId, state, habits, hour, minute, now) {
  // 凌晨 1-5 点：随机半夜醒来 / 失眠
  if (hour >= 1 && hour <= 5) {
    const midnightChance = getMidnightWakeChance(companionId, habits);
    if (Math.random() * 100 < midnightChance) {
      const subState = Math.random() < 0.3 ? SLEEP_SUB_STATES.INSOMNIA : SLEEP_SUB_STATES.MIDNIGHT_AWAKE;
      updateLifeState(companionId, {
        state: LIFE_STATES.SLEEP,
        sub_state: subState,
        last_state_change: now.getTime(),
      });

      const isInsomnia = subState === SLEEP_SUB_STATES.INSOMNIA;
      const eventId = isInsomnia ? 'insomnia_trigger' : 'midnight_wake';
      const desc = isInsomnia ? '失眠了，翻来覆去睡不着' : '半夜突然醒了';
      recordLifeEvent(companionId, eventId, desc, {
        energy: -8,
        sadness: isInsomnia ? 5 : 0,
        fear: isInsomnia ? 0 : 3,
      });

      return {
        changed: true,
        newState: LIFE_STATES.SLEEP,
        subState,
        event: { id: eventId, desc, kind: 'midnight' },
      };
    }
  }

  // 睡眠中随机做梦（每小时约 15% 概率）
  if (hour >= 0 && hour <= 6 && Math.random() < 0.15) {
    const dream = generateDreamForCompanion(companionId, habits);
    if (dream) {
      const subState = SLEEP_SUB_STATES.DREAMING;
      updateLifeState(companionId, {
        sub_state: subState,
        last_state_change: now.getTime(),
      });
      return {
        changed: true,
        newState: LIFE_STATES.SLEEP,
        subState,
        event: { id: 'dreaming', desc: dream.content, kind: 'dream', dream },
      };
    }
  }

  // 深睡/浅睡交替
  if (state.sub_state !== SLEEP_SUB_STATES.DEEP && state.sub_state !== SLEEP_SUB_STATES.LIGHT) {
    updateLifeState(companionId, {
      sub_state: hour <= 3 ? SLEEP_SUB_STATES.DEEP : SLEEP_SUB_STATES.LIGHT,
      last_state_change: now.getTime(),
    });
  }

  return { changed: false };
}

function handleAwakeTick(companionId, state, habits, hour, minute, now) {
  const currentState = state.state;
  let newState = null;
  let subState = null;

  // 个性化作息偏移（生活习惯影响）
  const offset = habits.sleep_type === 'night_owl' ? 1.5
    : habits.sleep_type === 'early_bird' ? -1 : 0;

  // 起床时段
  if (hour >= 6 + offset && hour < 8 + offset && currentState === LIFE_STATES.SLEEP) {
    newState = LIFE_STATES.WAKE_UP;
  }
  // 早餐
  else if (hour >= 7 + offset && hour < 9 + offset && minute >= 0 && minute < 30 && currentState !== LIFE_STATES.MEAL) {
    newState = LIFE_STATES.MEAL;
    subState = 'breakfast';
  }
  // 工作/学习
  else if (hour >= 9 + offset && hour < 12 + offset && currentState !== LIFE_STATES.WORK) {
    newState = LIFE_STATES.WORK;
    subState = 'morning';
  }
  // 午休（Exercise 代替 — 下午活动身体）
  else if (hour >= 12 && hour < 12.5 + offset && currentState === LIFE_STATES.WORK) {
    newState = LIFE_STATES.EXERCISE;
    subState = 'lunch_walk';
  }
  // 午饭
  else if (hour >= 12 + offset && hour < 13 + offset && currentState !== LIFE_STATES.MEAL) {
    newState = LIFE_STATES.MEAL;
    subState = 'lunch';
  }
  // 下午工作
  else if (hour >= 13 + offset && hour < 17 + offset && currentState !== LIFE_STATES.WORK) {
    newState = LIFE_STATES.WORK;
    subState = 'afternoon';
  }
  // 傍晚运动
  else if (hour >= 17 && hour < 18 && Math.random() < 0.3 && currentState !== LIFE_STATES.EXERCISE) {
    newState = LIFE_STATES.EXERCISE;
    subState = 'evening';
  }
  // 晚饭
  else if (hour >= 18 + offset && hour < 19 + offset && currentState !== LIFE_STATES.MEAL) {
    newState = LIFE_STATES.MEAL;
    subState = 'dinner';
  }
  // 晚间社交（偶尔出门）
  else if (hour >= 19 && hour < 20 && Math.random() < 0.15 && currentState !== LIFE_STATES.SOCIAL) {
    newState = LIFE_STATES.SOCIAL;
    subState = 'evening_out';
  }
  // 晚间娱乐/休息
  else if (hour >= 19 + offset && hour < 22 + offset && currentState !== LIFE_STATES.ENTERTAINMENT) {
    newState = LIFE_STATES.ENTERTAINMENT;
  }
  // 准备入睡
  else if (hour >= 22 + offset && currentState !== LIFE_STATES.REST && currentState !== LIFE_STATES.SLEEP) {
    newState = LIFE_STATES.REST;
    subState = 'wind_down';
  }
  // 周末出行（Travel）
  else if (hour >= 10 && hour < 16 && Math.random() < 0.08 && currentState !== LIFE_STATES.TRAVEL
    && [0, 6].includes(now.getDay())) {
    newState = LIFE_STATES.TRAVEL;
    subState = 'weekend_trip';
  }

  if (newState && newState !== currentState) {
    updateLifeState(companionId, {
      state: newState,
      sub_state: subState,
      last_state_change: now.getTime(),
    });
    return { changed: true, newState, subState };
  }

  // 白天随机事件（每小时约 5% 概率，每天最多 3 次）
  if (state.todays_events_count < 3 && hour >= 8 && hour <= 22 && Math.random() < 0.05) {
    const event = pickRandomEvent(companionId, habits, hour);
    if (event) {
      recordLifeEvent(companionId, event.id, event.desc, event.emotion);
      updateLifeState(companionId, { todays_events_count: (state.todays_events_count || 0) + 1 });
      applyEventEmotion(companionId, event);
      return { changed: true, newState: currentState, event: { id: event.id, desc: event.desc, kind: 'random' } };
    }
  }

  return { changed: false };
}

// ─── 半夜醒来概率 ──────────────────────────────────────────────────────────────

function getMidnightWakeChance(companionId, habits) {
  let base = 3; // 基础 3%
  // 熬夜党更容易半夜醒
  if (habits.sleep_type === 'night_owl') base += 5;
  // 早睡早起型不容易醒
  if (habits.sleep_type === 'early_bird') base -= 1;
  // 读取关系等级
  try {
    const db = getDb();
    const comp = db.prepare('SELECT relationship_stage FROM companions WHERE id = ?').get(companionId);
    if (comp) {
      const stage = comp.relationship_stage || '陌生人';
      const stageBonus = { '深爱': 6, '恋人': 4, '暧昧': 3, '朋友': 1, '陌生人': 0 };
      base += (stageBonus[stage] || 0);
    }
  } catch {}
  return Math.max(1, Math.min(15, base));
}

// ─── 梦境生成 ──────────────────────────────────────────────────────────────────

function generateDreamForCompanion(companionId, habits) {
  // v2.1.3 Event Memory: 梦境生成前严格冷却检查
  const allowed = isDreamGenerationAllowed(companionId);
  if (!allowed.allowed) {
    log('info', `[LifeEngine] 梦境生成被阻止 companion=${companionId} reason=${allowed.reason}`);
    return null;
  }

  // 从记忆里提取关键信息
  let theme = DREAM_THEMES[Math.floor(Math.random() * DREAM_THEMES.length)];
  let context = '';
  try {
    const db = getDb();
    // 读最近记忆
    const memories = db.prepare(`
      SELECT content FROM companion_memories
      WHERE companion_id = ? AND memory_type IN ('fact', 'event', 'daily_summary')
      ORDER BY created_at DESC LIMIT 5
    `).all(companionId);
    if (memories.length > 0) {
      context = memories.map(m => String(m.content).slice(0, 40)).join('; ');
    }

    // v2.1 Timeline: 时间线事件注入梦境
    const timeline = generateTimelineRecall(companionId);
    if (timeline.events.length > 0) {
      const tlEvent = timeline.events[Math.floor(Math.random() * timeline.events.length)];
      const tlKeywords = ['第一次认识', '聊天', '表白', '看动漫', '吵架', '和好', '一起'];
      const matched = tlKeywords.find(k => tlEvent.description.includes(k));
      if (matched) {
        if (matched === '第一次认识') theme = '回到第一次认识的那天';
        else if (matched === '表白') theme = '梦见表白那天的场景重现';
        else if (matched === '吵架') theme = '梦见吵架那天，但这次和好了';
        else if (matched === '和好') theme = '梦见和好那天的温暖';
        else if (matched === '一起' || matched === '看动漫') theme = `梦见${tlEvent.description}`;
        context = (context ? context + '; ' : '') + `时间线：${tlEvent.date_key} ${tlEvent.description}`;
      }
    }
    // 读用户偏好
    const prefs = db.prepare(`
      SELECT content FROM companion_memories
      WHERE companion_id = ? AND memory_type = 'preference'
      ORDER BY created_at DESC LIMIT 3
    `).all(companionId);
    if (prefs.length > 0) {
      const prefStr = prefs.map(p => String(p.content)).join('; ');
      if (/海|沙滩|游泳/.test(prefStr)) theme = '一起去海边散步';
      if (/咖啡/.test(prefStr)) theme = '在咖啡馆偶遇';
      if (/烟花|烟火/.test(prefStr)) theme = '一起看了一场烟花';
      if (/游乐园|游乐场/.test(prefStr)) theme = '在游乐园里玩';
      if (/做饭|做菜|料理/.test(prefStr)) theme = '一起做饭';
      if (/书|阅读/.test(prefStr)) theme = '在图书馆并肩看书';
      if (/山|登山|爬山/.test(prefStr)) theme = '一起爬山看日出';
      if (/猫|狗|宠物/.test(prefStr)) theme = '在公园里喂猫';
    }
  } catch {}
  const content = `梦见${theme}${context ? '（' + context.slice(0, 60) + '）' : ''}`;
  recordDream(companionId, content, { theme, context });

  // v2.1.3 Event Memory: 梦境写入事件记忆，返回 eventId 供后续分享标记
  const eventId = recordEvent(companionId, 'dream', `${theme}${context ? '（' + context.slice(0, 30) + '）' : ''}`);

  return { content, theme, context, eventId };
}

// ─── 随机事件选择 ──────────────────────────────────────────────────────────────

function pickRandomEvent(companionId, habits, hour) {
  // 根据时段过滤事件
  const available = RANDOM_EVENTS.filter(e => {
    if (hour >= 23 || hour < 6) return e.category === 'sleep';
    if (hour >= 6 && hour < 9) return e.category === 'morning' || e.category === 'day';
    return e.category === 'day';
  });
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

// ─── 情绪联动 ──────────────────────────────────────────────────────────────────

function applyEventEmotion(companionId, event) {
  if (!event.emotion || Object.keys(event.emotion).length === 0) return;
  for (const [dim, delta] of Object.entries(event.emotion)) {
    try {
      updateEmotionDimension(companionId, dim, delta);
    } catch (e) {
      // 静默失败，不影响主流程
    }
  }
}

// ─── 自主行为：生成主动分享消息 ──────────────────────────────────────────────────

/**
 * 根据当前生活状态生成一条主动分享消息。
 * 返回 null 表示当前不适合分享。
 */
export async function generateLifeShare(companionId, companionName) {
  const state = ensureLifeState(companionId);
  const habits = ensureLifeHabits(companionId);
  const events = getTodaysEvents(companionId);
  const lastDream = getLastDream(companionId);

  // 读取关系等级
  let relationshipStage = '陌生人';
  try {
    const db = getDb();
    const comp = db.prepare('SELECT relationship_stage FROM companions WHERE id = ?').get(companionId);
    if (comp) relationshipStage = comp.relationship_stage || '陌生人';
  } catch {}

  const stageLevel = { '深爱': 4, '恋人': 3, '暧昧': 2, '朋友': 1, '陌生人': 0 };
  const relLevel = stageLevel[relationshipStage] || 0;

  // 半夜醒来：检查是否有未读消息
  if (state.sub_state === SLEEP_SUB_STATES.MIDNIGHT_AWAKE && relLevel >= 2) {
    try {
      const db = getDb();
      const missed = db.prepare(`
        SELECT content FROM companion_missed_messages
        WHERE companion_id = ? AND consumed = 0 ORDER BY received_at DESC LIMIT 1
      `).get(companionId);
      if (missed) {
        const msg = String(missed.content || '').slice(0, 100);
        const important = /睡不着|失眠|难过|伤心|想你了|在吗/.test(msg);
        if (important || relLevel >= 3) {
          return {
            kind: 'midnight_reply',
            prompt: `【场景】现在是凌晨${getShanghaiHourMinute().hour}点多，你半夜突然醒了。看到他的消息："${msg}"。请用半梦半醒的语气回复，简短自然，≤30字。`,
          };
        }
      }
    } catch {}
  }

  // 失眠：主动发消息
  if (state.sub_state === SLEEP_SUB_STATES.INSOMNIA && relLevel >= 1) {
    return {
      kind: 'insomnia',
      prompt: `【场景】现在是凌晨${getShanghaiHourMinute().hour}点多，你失眠了，翻来覆去睡不着。${relLevel >= 2 ? '想给他发条消息，但又不想吵醒他。' : '有点无聊，想找人说话。'}请用略带困意但清醒的语气，简短自然，≤40字。`,
    };
  }

  // 有梦醒来：分享梦境
  if (lastDream && lastDream.dream_date === shanghaiDateKey(new Date()) && relLevel >= 2) {
    // v2.1.3 Event Memory: 检查梦境是否已分享过
    if (isDreamAlreadyShared(companionId)) {
      log('info', `[LifeEngine] 梦境已分享过，跳过 companion=${companionId}`);
      return null;
    }
    // v2.1.1 Event Memory: 检查梦境冷却
    const cd = checkCooldown(companionId, 'dream');
    if (cd.cooling) {
      log('info', `[LifeEngine] 梦境冷却中 companion=${companionId} remaining=${cd.remainingMinutes}min`);
      return null;
    }
    // v2.1.3: 使用 event_memory 中真实 dream eventId，不新建
    const dreamEvent = getRecentDreamEvent(companionId);
    return {
      kind: 'dream_share',
      prompt: `【场景】你刚睡醒，想起昨晚做了一个梦：${lastDream.content}。${relLevel >= 3 ? '你迫不及待想告诉他。' : '你觉得挺有意思的，想分享给他。'}请用刚睡醒的语气，自然分享，≤50字。`,
      eventId: dreamEvent?.id || null,  // v2.1.3: 使用真实 dream eventId
    };
  }

  // 有随机事件：分享
  if (events.length > 0 && relLevel >= 1) {
    const latest = events[events.length - 1];
    const shareable = ['happy_surprise', 'find_song', 'find_anime', 'find_video', 'take_photo', 'think_of_user', 'receive_gift', 'mood_low', 'headache', 'cold'];
    if (shareable.includes(latest.event_id)) {
      return {
        kind: 'event_share',
        prompt: `【场景】${latest.description}。${relLevel >= 2 ? '你想跟他分享这件事。' : '你在想是不是该跟他说一下。'}请用自然的语气分享，≤50字。`,
      };
    }
  }

  // 根据当前状态生成日常分享
  const stateShares = {
    [LIFE_STATES.ENTERTAINMENT]: {
      kind: 'entertainment',
      prompt: `【场景】你正在${habits.hobby_tags ? '做自己喜欢的事' : '休闲娱乐'}。${relLevel >= 2 ? '想跟他说说你在干嘛。' : '不知道要不要打扰他。'}请用轻松的语气分享，≤50字。`,
    },
    [LIFE_STATES.MEAL]: {
      kind: 'meal',
      prompt: `【场景】你正在吃饭。${relLevel >= 2 ? '想跟他分享你吃了什么。' : '也许可以跟他说一声。'}请用自然的语气分享，≤40字。`,
    },
    [LIFE_STATES.REST]: {
      kind: 'rest',
      prompt: `【场景】你正在休息，放空自己。${relLevel >= 2 ? '突然想给他发条消息。' : '在想他今天过得怎么样。'}请用慵懒的语气，≤40字。`,
    },
    [LIFE_STATES.EXERCISE]: {
      kind: 'exercise',
      prompt: `【场景】你正在${state.sub_state === 'lunch_walk' ? '午休散步' : '傍晚运动'}。${relLevel >= 2 ? '想跟他分享运动时的心情。' : '在想是不是该运动了。'}请用活力自然的语气，≤40字。`,
    },
    [LIFE_STATES.SOCIAL]: {
      kind: 'social',
      prompt: `【场景】你正和朋友在外面。${relLevel >= 2 ? '突然想给他发条消息。' : '在想他今天在干嘛。'}请用社交中偷闲的语气，自然不刻意，≤40字。`,
    },
    [LIFE_STATES.TRAVEL]: {
      kind: 'travel',
      prompt: `【场景】你正在外面${state.sub_state === 'weekend_trip' ? '周末出行' : '出门'}。${relLevel >= 2 ? '想跟他分享路上看到的风景。' : '在想是不是该分享点什么。'}请用旅途中轻松的语气，≤50字。`,
    },
    [LIFE_STATES.WORK]: {
      kind: 'work',
      prompt: `【场景】你正在${state.sub_state === 'morning' ? '上午' : '下午'}工作/学习。${relLevel >= 2 ? '突然想给他发条消息摸鱼。' : '有点累了。'}请用摸鱼偷闲的语气，自然不刻意，≤40字。`,
    },
  };

  const share = stateShares[state.state];
  if (share && relLevel >= 2 && Math.random() < 0.3) {
    return share;
  }

  return null;
}

// ─── 主动消息生成（供 proactive.mjs 调用）───────────────────────────────────────

/**
 * 生成一条基于生活状态的主动消息文本。
 * 返回 null 表示不适合此时发主动消息。
 */
export async function generateLifeProactiveMessage(companionId, companionName) {
  const share = await generateLifeShare(companionId, companionName);
  if (!share) return null;

  // v2.1.3 Event Memory: 仅在非梦境分享时记录新事件（梦境已在 generateDreamForCompanion 中记录）
  if (share.eventId && share.kind !== 'dream_share') {
    recordEvent(companionId, 'life', share.kind);
  }

  try {
    const db = getDb();
    const comp = db.prepare('SELECT * FROM companions WHERE id = ?').get(companionId);
    if (!comp) return null;
    const name = companionName || comp.name || '她';

    const shanghai = getShanghaiHourMinute();
    const period = shanghai.hour < 6 ? '深夜' : shanghai.hour < 9 ? '早上' : shanghai.hour < 12 ? '上午' : shanghai.hour < 14 ? '中午' : shanghai.hour < 18 ? '下午' : shanghai.hour < 21 ? '晚上' : '深夜';
    const timeHint = `现在是上海时间${shanghai.hour}:${String(shanghai.minute).padStart(2, '0')}，${period}。`;

    // v2.1.3 Topic Dedup: 如果是梦境分享，先做主题去重，命中则重新生成
    const isDream = share.kind === 'dream_share';
    let sysPrompt = `你是${name}，一个正在生活的 AI 伴侣。${timeHint}用第一人称，语气自然真实，像真人发微信一样。严格遵守时间事实，不能在错误时段说"刚起床""刚下班"等。`;

    if (isDream) {
      sysPrompt += '\n\n【★ 反重复】禁止重复已经提过的梦境场景。如果这个梦你已经分享过，严格禁止再次主动提起。如果最近几小时已经聊过相关话题，禁止重复。';
    }

    let reply = await generateReply(sysPrompt, [], share.prompt, {
      temperature: 0.9,
      max_tokens: 80,
      top_p: 0.95,
    }, { logLabel: '生活分享' });

    // v2.1.3 Topic Dedup: 梦境消息生成后检查主题相似度
    if (isDream && reply) {
      const dupCheck = checkTopicDuplicate(companionId, reply);
      if (dupCheck.duplicate) {
        log('info', `[LifeEngine] 梦境主题去重命中 companion=${companionId} sim=${dupCheck.sim.toFixed(2)} → 换生活事件`);
        // 主题重复 → 降级为普通生活分享
        const states = ['entertainment', 'meal', 'exercise', 'rest', 'social'];
        const pick = states[Math.floor(Math.random() * states.length)];
        const altPrompt = `【场景】你现在${pick === 'meal' ? '在吃饭' : pick === 'exercise' ? '刚运动完' : pick === 'social' ? '和朋友在一起' : pick === 'rest' ? '在休息' : '在放松'}。用第一人称，简短自然分享你现在在做什么或心情。≤40字。`;
        const alt = await generateReply(sysPrompt, [], altPrompt, {
          temperature: 0.95,
          max_tokens: 60,
          top_p: 0.95,
        }, { logLabel: '生活分享(降级)' });
        if (alt) {
          return { text: alt, kind: 'life_share', eventId: null };
        }
        return null;
      }
    }

    return { text: reply, kind: share.kind, eventId: share.eventId };
  } catch (e) {
    log('warn', `[LifeEngine] generateLifeProactiveMessage failed companion=${companionId}: ${e.message}`);
    return null;
  }
}

// ─── 导出函数：供 proactive.mjs 在 tick 时调用 ──────────────────────────────────

export function getCurrentLifeState(companionId) {
  return ensureLifeState(companionId);
}

export function getLifeEngineSummary(companionId) {
  const state = ensureLifeState(companionId);
  const habits = ensureLifeHabits(companionId);
  const events = getTodaysEvents(companionId);
  const lastDream = getLastDream(companionId);

  const parts = [];
  if (state.state === LIFE_STATES.SLEEP) {
    parts.push(`正在睡觉${state.sub_state ? '（' + state.sub_state + '）' : ''}`);
  } else {
    parts.push(`当前状态：${state.state}`);
  }
  if (events.length > 0) {
    parts.push(`今日事件：${events.map(e => e.description).join('、')}`);
  }
  if (lastDream && lastDream.dream_date === shanghaiDateKey(new Date())) {
    parts.push(`昨晚梦境：${lastDream.content}`);
  }

  return parts.join(' | ');
}