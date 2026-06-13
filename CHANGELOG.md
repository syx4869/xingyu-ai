# 星语 AI 变更日志

## V2.2.2 (2026-06-13)

### 修复 — 晚安消息中 AI 用自己的名字结尾（如"晚安，小溪"）

**根因**：LLM 生成晚安消息时，会用 companion 的名字做签名式结尾（"晚安，小溪"），但用户读起来像是在叫自己的名字，产生"你怎么把我叫成小溪了"的困惑。

**修复**：
- `proactive.mjs` goodnight userMessage：明确禁止"晚安，小溪"式签名结尾，引导用"晚安啦""好梦""早点睡哦"
- `companion.mjs` systemPrompt：新增【名字使用】规则，全局禁止在消息末尾用"晚安，${name}"格式

### 修改
- `proactive.mjs`：goodnight prompt 增加禁止签名式结尾
- `companion.mjs`：systemPrompt 增加名字使用规则

---

## V2.2.1 (2026-06-13)

### 修复 — "今天她想对你说"每天显示相同内容

**根因**：`GET /api/companions/:id/daily-thought` 自愈机制只在 thought 为 null 时触发异步生成。如果数据库里存在旧记录（cron 未运行 / LLM 调用失败 / generated_at 日期异常），API 永远返回旧数据，不会触发重新生成。

**修复**：
- **API stale 检测**：`generated_at` 日期不是今天 → 视为 stale → 返回 null + 后台 `force=true` 重新生成
- **前端 🔄 按钮**：卡片右侧新增刷新按钮，点击调用 `POST /api/companions/:id/daily-thought/regenerate` 强制重新生成
- **用户体验**：刷新时显示"正在想…"，生成完成后自动刷新卡片内容

### 修改
- `api.mjs`：`GET /daily-thought` 增加 `isStale` 检测 + `force` 参数
- `dashboard.html`：新增 🔄 按钮 + `regenerateThought()` 函数

---

## V2.2.0 (2026-06-13)

### 新增 — Event State Machine + Idempotency（事件生命周期状态机 + 幂等执行）

**根因**：event_memory 只记录"生成"，没有执行状态追踪，同一事件可在多个 tick 被重复执行。

**Event Lifecycle 状态机**：
```
CREATED → PLANNED → GENERATED → SENT → ACKNOWLEDGED → CLOSED
```
- 合法流转校验（非法流转拒绝 + warn 日志）
- 终态（CLOSED / ACKNOWLEDGED）事件：冷却/去重自动排除
- 用户回复时自动 SENT → ACKNOWLEDGED

**幂等机制**：
- `event_hash`：SHA-256 截断（companionId + type + summary），相同内容 → 相同 hash → 拒绝重复 INSERT
- `execution_lock`：CAS 原子操作（`UPDATE ... WHERE execution_lock = 0`），防止并发 tick 重复执行
- `recordEvent()` 内部幂等检查：hash 已存在 → 返回现有 eventId

**新增字段**（event_memory 表）：
- `event_state` TEXT — 生命周期状态
- `event_hash` TEXT — 内容幂等哈希
- `last_tick` INTEGER — 最后 tick 时间戳
- `execution_lock` INTEGER — 执行锁（0/1）

### 修改
- `db.mjs`：`migrateEventMemoryV2()` 添加 4 列 + 6 个新 CRUD（insertEventMemoryV2 / getEventByHash / transitionEventState / acquireEventLock / releaseEventLock / getRecentEventsByState）
- `event_memory.mjs`：v2.0 重写 — EVENT_STATES 枚举 + 合法流转校验 + eventHash + 幂等 guard + 执行锁 + recordEvent 内置幂等
- `life_engine.mjs`：`generateDreamForCompanion` 包裹 tryAcquireExecLock/markGenerated/releaseExecLock + findExistingEvent 幂等检查
- `proactive_engine.mjs`：`recordUserReplied` 调用 `acknowledgeRecentSent` 流转 SENT→ACKNOWLEDGED

---

## V2.1.3 (2026-06-12)

### 修复 — 梦境重复问题（Event Memory 链路修复）

**根因分析**：四个关键链路断裂导致梦境仍重复：
1. `generateDreamForCompanion` 无冷却检查，每 tick 15% 概率一晚上生成多次
2. `generateLifeShare` dream_share 用 `generateEventId` 新建 ID，与 `generateDreamForCompanion` 中 `recordEvent` 写入的 ID 不同 → `markMentioned` 标记错对象
3. `checkTopicDuplicate` 定义了但从未被调用
4. `generateLifeProactiveMessage` 中多余的 `recordEvent` 创建冗余 event_memory 记录

**修复内容**：
- `event_memory.mjs`：新增 `getRecentDreamEvent()` / `isDreamGenerationAllowed()` / `isDreamAlreadyShared()` 梦境专用函数；`recordEvent` 支持可选 eventId 参数
- `life_engine.mjs` `generateDreamForCompanion`：生成前调用 `isDreamGenerationAllowed`，24h 冷却或已分享则返回 null
- `life_engine.mjs` `handleSleepTick`：处理 `generateDreamForCompanion` 返回 null 的情况
- `life_engine.mjs` `generateLifeShare` dream_share：从 `event_memory` 查询真实 dream eventId，不再新建；新增 `isDreamAlreadyShared` 检查
- `life_engine.mjs` `generateLifeProactiveMessage`：删除多余的 `recordEvent`（梦境不重复记录）；接入 `checkTopicDuplicate`，主题相似度 >70% 时降级为普通生活分享

### 修改
- `event_memory.mjs`：+3 梦境专用函数，`recordEvent` 签名扩展
- `life_engine.mjs`：`generateDreamForCompanion` / `handleSleepTick` / `generateLifeShare` / `generateLifeProactiveMessage` 全部修复

---

## V2.1.2 (2026-06-12)

### 新增 — Event Memory 事件记忆系统
- **防主动消息重复**：同一事件只能主动提及一次，之后仅允许用户主动询问时回忆
- **事件唯一 ID**：`dream_20260612_001` 格式，`{type}_{YYYYMMDD}_{序号}`
- **数据库**：新增 `event_memory` 表（id/type/summary/createdAt/mentionedAt/mentionedCount）+ `event_topic_log` 表
- **冷却时间**：Dream 24h / Movie 12h / Life 6h，冷却期间禁止再次主动提及
- **Topic Deduplication**：记录最近 48 小时主动消息主题，相似度 ≥70% 时重生内容
- **Prompt 规则**：禁止重复已提及事件、禁止连续围绕同一梦境、优先生成新生活事件
- **生命周期**：梦境生成时写入 event_memory → 主动消息发送后标记 mentionedCount + 记录 topic

### 修改
- `event_memory.mjs`：新建，核心模块（ID 生成/CRUD/冷却检查/主题去重/Prompt 构建）
- `db.mjs`：新增 `migrateEventMemory()` + 6 个 CRUD 函数（insertEventMemory/markEventMentioned/getRecentEvents/getUnmentionedEvents/insertTopicLog/getRecentTopics）
- `proactive.mjs`：systemPrompt 注入 Event Memory 规则，发送后记录 topic + 标记事件
- `life_engine.mjs`：梦境生成同步写入 event_memory，dream_share 前检查冷却

---

## V2.1.1 (2026-06-12)

### 修复
- **全项目时区 bug**：`life_engine.mjs` / `proactive_engine.mjs` / `emotion_state.mjs` / `plan_tasks.mjs` 中 `new Date().getHours()` 返回服务器本地时间而非上海时间，导致状态机时段判断、主动消息调度、情绪能量计算全部偏移
- **新增 `getShanghaiHourMinute()` / `shanghaiHour()` 工具函数**：统一使用 `Intl.DateTimeFormat` + `Asia/Shanghai` 获取时间
- **`generateLifeProactiveMessage` 缺时间注入**：sysPrompt 完全没有时间信息，AI 在生活分享路径下不知道现在几点

---

## V2.1 (2026-06-12)

### 新增 — Timeline Engine 时间线引擎
- **时间线记录**：`companion_timeline` 表，每条事件含日期、描述、分类、参与角色
- **自动记录里程碑**：首次认识用户、首次聊天、AI 表白、用户表白均自动写入时间线
- **时间线回忆**：`generateTimelineRecall()` 查询 7 天前的事件，生成"上个月你们一起看了动漫"等自然语言回忆
- **主动消息集成**：proactive 消息 prompt 注入时间线回忆，AI 可自然引用"还记得上个月..."
- **梦境集成**：时间线事件匹配到梦境主题（表白→梦见表白场景重现，吵架→梦见和好）
- **CRUD 接口**：`recordTimelineEvent()` / `getTimeline()` / `getTimelineForPeriod()` / `getRecentMilestone()`

### 修改
- `timeline.mjs`：新建，核心引擎（建表 + CRUD + 回忆生成 + 自动里程碑）
- `db.mjs`：注册 `migrateTimeline()` 迁移
- `proactive.mjs`：导入 `generateTimelineRecall`，系统 prompt 注入时间线回忆
- `life_engine.mjs`：导入 `generateTimelineRecall`，梦境生成匹配时间线
- `bot.mjs`：导入 `autoRecordMilestones`，首次聊天/表白时自动记录时间线

---

## V2.0 (2026-06-12)

### 新增 — Life Engine 生活模拟引擎（完整版）
- **状态机全覆盖**：Sleep / Work / Rest / Entertainment / Travel / Social / Meal / Exercise 全部接入日程调度
- **Sleep 细分**：DeepSleep / LightSleep / Dreaming / MidnightAwake / Insomnia
- **随机事件系统**：16 种事件（噩梦/半夜醒/失眠/口渴/起夜/睡过头/感冒/头疼/开心事/新歌/新动漫/有趣视频/照片/想到用户/收到礼物/心情低落）
- **半夜醒来机制**：1~15% 概率，按性格（night_owl/early_bird）和关系等级调整，醒来检查未读消息
- **梦境系统**：根据记忆 + 偏好生成梦境，醒来后可分享
- **生活习惯系统**：独立作息（sleep_type 偏移所有日程时间），兴趣/喜好影响梦境和分享内容
- **自主行为系统**：Work/Meal/Entertainment/Exercise/Social/Travel 各状态均可触发日常分享，音乐/动漫/照片分享
- **全链路联动**：生活事件联动情绪（applyEventEmotion），记忆用于梦境，关系等级影响分享频率，接入 proactive.mjs 每分钟触发自主分享

### 修改
- `life_engine.mjs`：补全 8 状态机调度 + 个性化作息偏移 + 音乐/动漫/照片事件
- `proactive.mjs`：导入 `generateLifeProactiveMessage`，`life_share` kind 每分钟触发，5 分钟硬间隔，使用预生成文本不调 LLM

---

## V1.2.1 (2026-06-11)

### 修复
- **`sendAndRecord` 发送失败检测**：`bot.mjs` 的 `sendAndRecord` 现在检查 `sendTextMessage` 返回值，发送失败时不写入 DB，避免"日志显示已发送但用户未收到"的幽灵消息
- **`proactive` ctx 补全 `baseUrl`**：`sendProactiveMessage` 构造 `ctx` 时显式带上 `baseUrl`，消除与 `getBotContextForCompanion` 返回结构的不一致

---

## V1.2 (2026-06-11)

### 修复
- **统一日志标签**：`generateReply` 所有调用方传入明确标签，避免终端里 `[ai] 回复:` 混用导致无法区分内心/记忆总结/主动消息/被动回复
- **proactive 睡眠拦截**：`proactive.tick()` 增加 `is_sleeping` 检查，AI 入睡后不再发主动消息
- **setup 自定义 provider 完整校验**：`setup/status` 对 openai-compatible / ollama 要求 Key + Base URL + Model 三者齐全才返回 `configured=true`
- **dashboard isCustom 兼容 ollama**：模型设置页对 ollama 也显示 Base URL + Model 输入框
- **chat.mjs activeModel 优先级**：custom provider 优先使用自身的 model 设置，不再被全局 `CHAT_MODEL` 覆盖
- **.env 默认 provider**：注释掉 `CHAT_PROVIDER=deepseek`，避免环境变量覆盖 SQLite 中保存的设置

### 其他
- 品牌名全局替换：`溪语` → `星语`
- Life Engine v2.0.0：新增 `companion_life_state` 表（用户自建功能）

---

## V1.1 (2026-06-11)

### 修复
- `inner_os` 日志标签从 `回复` 改为 `内心`，避免与真实回复混淆

---

## V1 (2026-06-11)

### 初始备份
- 修复 provider 切换 bug、proactive 睡眠期间发送 bug 后的完整代码备份
- 推送至 GitHub `https://github.com/syx4869/xingyu-ai`
