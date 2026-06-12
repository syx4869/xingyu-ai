# 星语 AI 变更日志

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
