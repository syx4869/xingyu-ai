# 星语 AI (Xiyu AI) — 代码百科 (Code Wiki)

> **版本**: v1.21.4 | **协议**: MIT | **运行时**: Node.js >= 20 | **数据库**: SQLite (better-sqlite3 + WAL)

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [目录结构](#3-目录结构)
4. [核心模块详解](#4-核心模块详解)
   - [4.1 入口层](#41-入口层)
   - [4.2 API 路由层](#42-api-路由层)
   - [4.3 对话处理层](#43-对话处理层)
   - [4.4 人设与记忆层](#44-人设与记忆层)
   - [4.5 情绪与关系层](#45-情绪与关系层)
   - [4.6 主动消息层](#46-主动消息层)
   - [4.7 多模态层](#47-多模态层)
   - [4.8 Provider 抽象层](#48-provider-抽象层)
   - [4.9 安全与护栏层](#49-安全与护栏层)
   - [4.10 数据访问层](#410-数据访问层)
   - [4.11 辅助与服务层](#411-辅助与服务层)
5. [前端架构](#5-前端架构)
6. [数据库设计](#6-数据库设计)
7. [依赖关系图](#7-依赖关系图)
8. [项目运行方式](#8-项目运行方式)
9. [脚本与工具链](#9-脚本与工具链)
10. [扩展与定制](#10-扩展与定制)

---

## 1. 项目概述

**星语 AI** 是一个开源的 AI 陪伴框架，默认设定为一个"心里已经悄悄喜欢你的 AI 女友"。项目将大语言模型组织成一个具有真实情绪、记忆、边界和主动性的虚拟人格，支持 **微信** 和 **Web Playground** 两种交互渠道。

### 核心设计理念

- **真人感 = 减法**：拒绝"太好了"的 AI 味（太及时、太顺从、太完美）
- **北极星**：「愿意在真实生活的空隙给你温柔和陪伴」——少、准、轻，不是填满
- **确定性兜底**：每条产品规则配出口清洗/硬注入/状态机喂值，不靠 prompt 自觉

### 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js (ESM) |
| Web 框架 | Express 5.x |
| 数据库 | SQLite (better-sqlite3, WAL 模式) |
| AI 集成 | 多 Provider 抽象层（11 家 Chat / 6 家 Image / 8 家 Vision / 7 家 ASR / 5 家 TTS / 4 家 Embedding / 4 家 Search） |
| 微信接入 | 腾讯 iLink / ClawBot 协议 |
| 图像处理 | sharp |
| 前端 | 原生 HTML/CSS/JS（Glassmorphism UI + PWA） |

---

## 2. 整体架构

```
                   ┌──────────────────────────────────────────────┐
                   │  浏览器 (Web Dashboard / Playground)  微信用户  │
                   └──────────────────────┬───────────────────────┘
                                          │
   ┌────────────────────────────────────────────────────────────────┐
   │  Express (index.mjs) — 多租户 iLink 轮询池                      │
   │  ┌─────────────┬──────────────┬─────────────────────────────┐ │
   │  │  api.mjs    │  auth.mjs    │  Setup Wizard / Dashboard   │ │
   │  └─────────────┴──────────────┴─────────────────────────────┘ │
   │  ┌──────────────────────────────────────────────────────────┐ │
   │  │  bot.mjs (微信入口)      playground.mjs (Web入口)         │ │
   │  │         ↓                          ↓                      │ │
   │  │  公共 reply pipeline：buildSystemPrompt + recallMemory    │ │
   │  │         ↓                                                 │ │
   │  │  ai.mjs → providers/ → chat/image/vision/asr/tts/...     │ │
   │  │         ↓                                                 │ │
   │  │  memory_v2.mjs · emotion_state.mjs · proactive.mjs       │ │
   │  │  · persona_guard.mjs · companion.mjs · diary.mjs         │ │
   │  └──────────────────────────────────────────────────────────┘ │
   │  ┌──────────────────────────────────────────────────────────┐ │
   │  │  db.mjs (better-sqlite3 + WAL)                           │ │
   │  └──────────────────────────────────────────────────────────┘ │
   └────────────────────────────────────────────────────────────────┘
```

### 关键架构决策

1. **同一份 reply pipeline**：微信和 Playground 共用 `buildSystemPrompt` + `recallMemory` + `chatComplete` 链路，只在入口和派发层分化
2. **Provider Facade 模式**：业务层调用 `chatComplete()` / `imageGenerate()` 等通用方法，厂商差异隐藏在 `src/providers/*.mjs`
3. **多租户 iLink 轮询池**：每个活跃微信账号独立长轮询 `getUpdates`，启动时从 DB 加载，运行时动态注册/注销
4. **隐私过滤挂载在最窄腰部**：所有长期存储写入函数入口统一经过 `privacy_filter.mjs`，确保全覆盖

---

## 3. 目录结构

```
xiyu-ai/
├── index.mjs                     Express 入口 + iLink 轮询池（多租户）
├── package.json                  依赖与脚本
├── Dockerfile / docker-compose.yml  容器化部署
├── .env / .env.example           环境配置
├── config/
│   ├── annotation_tags.json      标注标签配置
│   └── provider_pricing.example.json  定价模板
├── deploy/                       部署模板
│   ├── xiyu-ai.service           systemd unit
│   ├── xiyu-ai-backup.service    数据库备份 service
│   ├── xiyu-ai-backup.timer      备份定时器
│   └── nginx.conf.example        nginx 反代配置
├── docs/                         设计文档
│   ├── FEATURES.txt              完整功能清单
│   ├── CONFLICT_ARC.md           冲突与和好弧设计
│   ├── EMOTION_SYSTEM.md         情绪系统设计
│   ├── HANDOFF.md                新对话交接提示词
│   ├── PRODUCTION.md             生产部署指南
│   └── ROADMAP.md                路线图
├── src/                          后端核心源码
│   ├── providers/                AI Provider 抽象层
│   │   ├── chat.mjs              11 家大模型聊天
│   │   ├── image.mjs             6 家图像生成
│   │   ├── vision.mjs            8 家视觉理解
│   │   ├── asr.mjs               7 家语音识别
│   │   ├── tts.mjs               5 家语音合成
│   │   └── embedding.mjs         4 家文本向量化
│   ├── security/
│   │   └── netguard.mjs          SSRF 防护下载
│   ├── ai.mjs                    AI 业务层 Facade
│   ├── api.mjs                   REST API 路由 (199KB)
│   ├── bot.mjs                   微信消息处理
│   ├── companion.mjs             18 节 System Prompt 合成
│   ├── memory.mjs / memory_v2.mjs 记忆系统
│   ├── emotion_state.mjs         11 维情绪状态机
│   ├── inner_os.mjs              Inner OS 内心独白
│   ├── proactive.mjs             主动消息调度
│   ├── proactive_engine.mjs      主动消息引擎（motivation 三驱动）
│   ├── proactive_material.mjs    主动消息素材管理
│   ├── proactive_deadman.mjs     主动消息死人开关
│   ├── relationship_arc.mjs      冲突与和好弧状态机
│   ├── relationship_arc_runtime.mjs  弧联动 IO 层
│   ├── moderation.mjs            危机干预 + 冲突红线护栏
│   ├── minor_guard.mjs           未成年人保护
│   ├── privacy_filter.mjs        隐私过滤
│   ├── persona_guard.mjs         人设一致性校验
│   ├── reflection.mjs            AI 反思引擎
│   ├── diary.mjs                 日记生成
│   ├── relational_diary.mjs      反向日记
│   ├── thoughts.mjs              每日想对你说
│   ├── photo_intent.mjs          照片请求意图识别
│   ├── photo_planner.mjs         照片 AI 决策器
│   ├── photo_sender.mjs          照片生成与发送
│   ├── visual_identity.mjs       稳定视觉人设
│   ├── visual_identity_candidates.mjs  4 候选自拍选脸
│   ├── image_beautify.mjs        全局轻美颜
│   ├── voice_pipeline.mjs        mp3→SILK 转码
│   ├── voice_inbound.mjs         入站语音处理
│   ├── voice_emotion.mjs         语音情绪识别
│   ├── plan_tasks.mjs            cron 定时任务
│   ├── ilink.mjs                 iLink 协议封装
│   ├── media.mjs                 CDN 媒体上传
│   ├── sleep.mjs                 作息与睡眠系统
│   ├── auth.mjs                  认证/Token
│   ├── admin.mjs                 管理员系统
│   ├── email.mjs                 邮件发送
│   ├── db.mjs                    SQLite 数据层
│   ├── logger.mjs                日志
│   ├── ratelimit.mjs             限流
│   ├── stickers.mjs              表情包
│   ├── shaping.mjs               共建留痕（教她说话）
│   ├── user_profile.mjs          用户画像
│   ├── open_loops.mjs            开环记忆
│   ├── persona_export.mjs        人设导入/导出
│   ├── event_graph.mjs           事件图谱
│   ├── achievements.mjs          成就系统
│   ├── escalation.mjs            被反复戳情绪升级
│   ├── text_similarity.mjs       文本相似度
│   ├── time_capsule.mjs          时光胶囊
│   ├── letter.mjs                留言胶囊
│   ├── provider_costs.mjs        用量成本估算
│   ├── inbound_dedup.mjs         入站消息去重
│   ├── web_search.mjs            联网搜索
│   ├── backfill_history.mjs      互动历史自动打底
│   ├── arc_log_sink.mjs          弧事件日志
│   ├── ai_taste_guard.mjs        AI 味防护
│   └── playground.mjs            Web Playground
├── public/                       前端资源
│   ├── index.html                官网/落地页
│   ├── app/                      17 个前端页面
│   │   ├── dashboard.html        主控制台
│   │   ├── playground.html       浏览器聊天
│   │   ├── setup.html            首次配置向导
│   │   ├── auth.html             登录/注册
│   │   ├── create.html           创建 AI 角色
│   │   ├── bind.html             扫码绑微信
│   │   ├── diary.html            日记翻书
│   │   ├── memories.html         记忆管理
│   │   ├── admin.html            管理员后台
│   │   ├── emotion-debug.html    情绪调试面板
│   │   ├── annotate.html         样本标注工具
│   │   ├── i18n.js               国际化
│   │   ├── theme.js              主题切换
│   │   └── glass.css             液态玻璃 UI
│   ├── assets/                   静态资源
│   ├── avatars/                  头像预设
│   ├── sw.js                     Service Worker
│   └── manifest.webmanifest      PWA 清单
├── scripts/                      80+ 运维/测试脚本
├── assets/
│   └── stickers/                 表情包加载机制
└── data/                         运行时数据 (gitignored)
```

---

## 4. 核心模块详解

### 4.1 入口层

#### `index.mjs` — 主入口

**职责**：Express 服务器启动 + iLink 多租户轮询池管理。

**关键导出/函数**：

| 函数 | 说明 |
|------|------|
| `registerBotAccount(account)` | 向轮询池注册一个微信 bot 账号，启动独立 `runLoop` |
| `unregisterBotAccount(botId)` | 从轮询池移除 bot，标记过期 |
| `listBotPool()` | 返回当前池中所有 bot 的状态 |
| `bootstrap()` | 启动流程：初始化 DB → 加载管理员凭据 → 启动 API → 启动 proactive + plan_tasks + iLink send drain → 加载所有 active 绑定 |

**核心流程**：
```
bootstrap()
├── getDb()                              # 初始化 SQLite
├── loadAdminCredentials()               # 加载/生成管理员密码
├── startApiServer()                     # 启动 Express (端口3000)
├── setBotPoolHandle()                   # 注入 pool 句柄到 api.mjs
├── startProactiveScheduler()            # 启动主动消息调度
├── startPlanTasks()                     # 启动 cron 任务
├── startIlinkSendDrainLoop()            # iLink 发送限速队列
├── getActiveBotAccounts()               # 从 DB 加载所有 active 绑定
├── registerBotAccount() × N             # 逐个注册到 pool
└── 尝试加载 env/文件 iLink 凭据
```

**Pool 设计**：每个 bot 独立 runLoop，5 分钟心跳，5 秒重试。session 过期时自动检测空绑定并停用，避免死轮询。

---

### 4.2 API 路由层

#### `src/api.mjs` — REST API 路由（199KB，项目最大文件）

**职责**：全部 HTTP API 路由，涵盖 Companion CRUD、记忆、情绪、照片、设置、管理员等所有端点。

**路由分组**：

| 路由前缀 | 功能 |
|----------|------|
| `POST /api/auth/*` | 登录、注册、Token 刷新、验证码 |
| `POST /api/setup/*` | 首次配置向导（Provider 测试连通） |
| `GET/POST/PUT /api/companions` | Companion CRUD |
| `GET/PUT /api/companions/:id/*` | 状态/记忆/日记/提醒/导出/成就 |
| `POST /api/playground/chat` | 浏览器聊天 (SSE) |
| `POST /api/playground/voice` | 语音识别 + TTS |
| `GET/POST /api/wechat/*` | 微信绑定/解绑/扫码 |
| `GET/POST /api/admin/*` | 管理员端点 |
| `GET /api/health` | 健康检查 |
| `GET /api/memories` | 记忆查询 |
| `GET /api/user/profile` | 用户画像 |
| `GET /api/providers/*` | Provider 列表和状态 |

**鉴权体系**：

| 中间件 | 说明 |
|--------|------|
| `requireAuth` | 完整鉴权（JWT Token） |
| `softAuth` | 软鉴权（允许特定白名单场景匿名） |
| `requireAdmin` | 管理员鉴权 |
| `rateLimit` | 频率限制 |

**关键依赖**：几乎依赖 `src/` 下所有模块——通过统一的 import 把所有业务模块接入 Express 路由。

---

### 4.3 对话处理层

#### `src/bot.mjs` — 微信消息处理

**职责**：处理从 iLink 轮询池收到的微信消息，走完整 reply pipeline 生成回复，通过 iLink send 派发。

**关键函数**：

| 函数 | 说明 |
|------|------|
| `handleMessage(msg, ctx)` | 消息主入口：解析消息类型 → 权限检查 → 调用 reply pipeline → 发送回复 |
| `splitReplySegments(text)` | 将 AI 回复按 `||` 分割为多条（模拟真人连发） |
| 连发合并 | 用户连发 2-3 条消息时，等待窗口期（默认 10s）合并为一轮再回复 |

**处理流程**：
```
handleMessage()
├── 1. 文本/图片/语音消息解析
├── 2. 睡眠检查 → 入睡时段静默，塞入 missed_messages
├── 3. 敏感内容检测 (moderation.mjs)
├── 4. 未成年人检测 (minor_guard.mjs)
├── 5. 冲突弧处理 (relationship_arc_runtime.mjs)
├── 6. 共建检测 (shaping.mjs::detectTeaching)
├── 7. 入站去重 (inbound_dedup.mjs)
├── 8. buildSystemPrompt() → 18 节 context 拼合
├── 9. privoxy+search 决策 → 是否需联网搜索
├── 10. chatCompleteWithRetry() → LLM 调用
├── 11. 回复前回复中多层过滤
├── 12. persona_guard.mjs → 一致性校验
├── 13. splitReplySegments() → 分割为多条
├── 14. iLink sendMessage() → 逐条发送
└── 15. 记忆提取 + 情绪更新
```

#### `src/playground.mjs` — Web 聊天

**职责**：浏览器端 SSE 流式聊天。与 `bot.mjs` 共用同一套 `buildSystemPrompt` + `recallMemory` + `chatComplete` 链路，差异仅在入口和输出（SSE 流 vs iLink send）。

#### `src/ai.mjs` — AI 业务层 Facade

**职责**：所有 AI 调用的统一入口。封装重试、用量记录、联网搜索调度等横切逻辑。不直接调用任何厂商 API，全部委托 `src/providers/`。

**关键导出**：

| 函数 | 说明 |
|------|------|
| `chatCompleteWithRetry(args)` | 聊天请求 + 指数退避重试（默认 2 次） |
| `generateImage(prompt, opts)` | 图像生成 |
| `recognizeVision(imageUrl, prompt)` | 视觉识别 |
| `recognizeVoice(audioPath)` | 语音识别 |
| `embedText(text)` | 文本向量化 |
| `generatePersonaFacts(profile)` | 生成 46+ 条人生事件 |
| `generateAvatarCandidates(profile)` | 生成 4 个候选头像 |
| `extractStructuredInfo(messages)` | 从对话中提取结构化信息 |

**重试策略**：
- 可重试：超时 / 429 / 5xx / 网络错误 → 指数退避（base×3^n + jitter）
- 不可重试：401 key 错误 / 403 权限 / 400 格式 / 404 模型不存在 → 立即抛

---

### 4.4 人设与记忆层

#### `src/companion.mjs` — System Prompt 合成

**职责**：合成 18 节结构化 System Prompt，每轮对话前动态组装。输出的 prompt 决定了她的全部行为。

**18 节 Prompt 结构**：
1. 元认知（你是谁）
2. 关系阶段（暧昧/恋人/深爱）
3. 当前好感度 + 情绪状态
4. 长期记忆摘要
5. 日程（她正在做什么）
6. 用户画像
7. 偏好账本（like/dislike/taboo）
8. 共建留痕（他教的称呼/口头禅/雷区/约定）
9. 开环记忆（她记得的未完成事项）
10. 冲突弧状态
11. 近期聊天摘要
12. 日记最近片段
13. Inner OS 指令
14. 反 AI 味规则
15. 照片规则
16. 主动消息状态
17. 安全模式提示
18. 强制指令

**关键导出**：
- `buildSystemPrompt(companion, ctx)` — 主入口，返回完整 system prompt 字符串

#### `src/memory_v2.mjs` — 7 层记忆系统

**职责**：结构化记忆存储与语义召回。

**7 层分类**：
| 层 | 类型 | 说明 |
|----|------|------|
| 1 | core_persona | 核心人设事实（她是谁） |
| 2 | relationship_rule | 关系规则（怎么对你） |
| 3 | user_fact | 用户事实（你是谁） |
| 4 | preference | 偏好（喜欢/讨厌什么） |
| 5 | event | 事件记忆 |
| 6 | emotion | 情绪记忆 |
| 7 | summary | 摘要记忆 |

**关键函数**：
- `recallMemories(companionId, userMsg, limit)` — 语义召回 + 关键词兜底
- `addMemory(companionId, memory)` — 添加记忆（经隐私过滤）
- `applyMemoryDecayBatch(companionId)` — 遗忘曲线衰减
- `pinMemory / lockMemory / archiveMemory` — 记忆生命周期管理
- `findSimilarMemoryByEmbedding(text)` — 向量语义搜索

#### `src/shaping.mjs` — 共建留痕

**职责**：识别用户"教她"的意图（称呼/口头禅/雷区/约定），自动记录并注入 prompt。

**关键函数**：
- `detectTeaching(text)` — 规则检测用户的"教学/纠正/约定"意图
- `buildShapingPromptHint(companionId)` — 把已学到的规则注入 prompt

---

### 4.5 情绪与关系层

#### `src/emotion_state.mjs` — 11 维情绪状态机

**职责**：管理 AI 的实时情绪状态，每条消息增量演化 + 半小时定时重算 + 防刷衰减。

**11 个维度**：

| 维度 | 说明 | 范围 |
|------|------|------|
| affection | 好感度 | 0-100 |
| trust | 信任度 | 0-100 |
| dependency | 依赖度 | 0-100 |
| possessiveness | 占有欲 | 0-100 |
| security | 安全感 | 0-100 |
| patience | 耐心 | 0-100 |
| annoyance | 烦躁度 | 0-100 |
| energy | 能量 | 0-100 |
| mood | 心情类别 | sad/happy/angry/anxious/neutral/clingy/shy/playful/calm |
| missing_level | 想念档 | 0-4 |
| attention | 注意力 | 0-100 |

**关键导出**：
- `updateEmotionFromUserMessage(companionId, text)` — 用户消息关键词触发各维度增减
- `getEmotionStateWithDefaults(companionId)` — 获取当前情绪状态
- `buildEmotionPromptHint(state)` — 情绪状态 → prompt 指令
- `tickIdleEmotion(companionId)` — 定时重算（空闲想念递增）

#### `src/inner_os.mjs` — Inner OS 内心独白

**职责**：每轮先生成内心想法（不发送）再写对外回复。内心和嘴上的落差是真人感的核心。

**核心流程**：
1. 先生成 `inner_thought`（心里想的）
2. 基于 inner_thought 生成 `outer_reply`（说出口的）
3. 冲突弧检测：判断 inner 与 outer 是否一致

#### `src/relationship_arc.mjs` — 冲突与和好弧状态机

**职责**：管理"她受伤了 → 冷战 → 修复中 → 和好"的完整状态机。

**状态定义**：
```
neutral → hurt → cold → withdrawing → repairing → scar → healed
```

**两类触发**：
- **wound（伤害类）**：踩雷区/伤人话 → 必须正面道歉才解锁修复
- **distance（冷落类）**：被冷落 → 重逢即开始回暖

**硬约束**：
- 绝无永久冷战（硬时长上限）
- 和好入长期记忆（"上次你说过不查岗"）
- 安全模式封顶（冲突期不降级到安全底线以下）

#### `src/relationship_arc_runtime.mjs` — 弧联动 IO 层

**职责**：将冲突弧状态机与聊天管道、主动消息、prompt 注入等外围系统联动。读取弧状态 → 影响 system prompt / 禁止撒娇/照片/告白 → 记录弧事件。

#### `src/escalation.mjs` — 被反复戳情绪升级

**职责**：检测"同一 pushy 消息连发/反复同一索求"，输出 0-3 级升级档位与对应硬指令。

**升级逻辑**：
- Level 0：正常
- Level 1：轻微被 push（她回绝过一次）
- Level 2：持续施压 → 撤退
- Level 3：严重越界 → 强硬拒绝

---

### 4.6 主动消息层

#### `src/proactive.mjs` — 主动消息调度器

**职责**：管理主动消息的触发时机、频率限制、素材选择和发送。

**三种主动消息类型**：
- 早安/晚安（时间段触发 + 双闸防重）
- 日间随机（motivation score 驱动）
- 主动告白（好感 >= 50 + 双方未表白 + 认识 >= 5 天）

**防复读机制**：
- 事前：发送前用字符 3-gram Jaccard 检测最近 5 条 assistant 内容；相似度 >= 0.6 升温重生
- 素材级：同梗（某只猫、某件小事）说过一次冷却 14 天

#### `src/proactive_engine.mjs` — 主动消息引擎 v2

**职责**：三驱动 motivation 计算。

```
motivation = base_time_score × emotion_multiplier × schedule_multiplier × random_jitter
```

- **base_time_score (0-80)**：纯时段（早晚高峰最高，凌晨最低）
- **emotion_multiplier (0.2-2.5)**：7 维情绪合成
- **schedule_multiplier (0.3-1.5)**：基于今日日程当前活动
- **random_jitter (0.8-1.2)**：真人不机械

#### `src/sleep.mjs` — 作息与睡眠系统

**职责**：管理 companion 的作息（默认 00:30-07:30，每天小幅波动）。

**功能**：
- 入睡时段内消息静默拦截（不发"正在输入"）
- dashboard 可"打电话叫醒"（带起床气）
- 7 天学习期自动适配用户作息
- 晚安留"再陪陪我"挽留窗口

---

### 4.7 多模态层

#### `src/photo_intent.mjs` — 照片请求意图识别

**职责**：识别用户消息中是否包含"要照片/自拍"意图，判断是否有权发照片。

#### `src/photo_planner.mjs` — 照片 AI 决策器

**职责**：决策照片的拍摄类型、机位、比例。

**机位路由**：
| 类型 | 说明 | 比例 |
|------|------|------|
| selfie | 自拍 | 3:4 竖屏 |
| environmental_selfie | 环境自拍（对镜子/窗户） | 3:4 竖屏 |
| activity_pov | 拍手头在做的事 | 3:4 竖屏 |
| scenery | 风景 | 16:9 横屏 |

**真实性约束**：时间光线与聊天内容自洽、拒绝深夜/清晨不合逻辑的照片请求。

#### `src/photo_sender.mjs` — 照片生成与发送

**职责**：调用 imageGenerate → 美颜 → 比例转码 → CDN 上传 → iLink 发送。

#### `src/visual_identity.mjs` — 稳定视觉人设

**职责**：维护每个 companion 的外貌描述和锁定参考图，确保每次生成的图片是同一张脸。

#### `src/visual_identity_candidates.mjs` — 4 候选自拍选脸

**职责**：创建时生成 4 张自拍候选，用户选择一张锁定基准脸，后续所有生成用 i2i 参考图锚定。

#### `src/image_beautify.mjs` — 全局轻美颜

**职责**：所有发出去的图片自动经过轻美颜后处理（微提亮 + 增饱和 + 微对比 + 极轻高斯模糊）。可通过 `IMAGE_BEAUTIFY_ENABLED=false` 关闭。

#### `src/voice_pipeline.mjs` — 语音转码

**职责**：mp3 → SILK 转码（供微信语音使用）。因 iLink 协议禁止 outbound voice，当前仅在网页端生效。

#### `src/voice_inbound.mjs` — 入站语音处理

**职责**：微信语音下载 + 解密 + 解码为 PCM/WAV。

#### `src/voice_emotion.mjs` — 语音情绪识别

**职责**：使用 qwen-audio 等 Vision Provider 识别语音中的情绪（温柔/撒娇/不耐烦），不只听文字内容。

#### `src/media.mjs` — CDN 媒体上传

**职责**：将图片/文件加密后上传到微信 CDN，获取 downloadParam 用于发送。支持 AES-128-ECB 加密。

---

### 4.8 Provider 抽象层

#### 架构模式

每个 Provider 模块统一使用 **REGISTRY + getActiveXxxProvider** 模式：

```javascript
// 以 chat.mjs 为例
export const REGISTRY = { deepseek: { ... }, openai: { ... }, ... };
export function getActiveChatProvider() { ... }
export function chatComplete(args) { ... }
```

Provider 切换只需改 `.env` 环境变量（如 `CHAT_PROVIDER=deepseek`），或在 `/app/setup.html` 网页中配置，不改一行代码。

#### `src/providers/chat.mjs` — 聊天 (11 家)

| Provider | 模型标识 |
|----------|----------|
| DeepSeek | `deepseek` |
| OpenAI | `openai` |
| Anthropic Claude | `anthropic` |
| Google Gemini | `gemini` |
| xAI Grok | `xai` |
| 智谱 GLM | `zhipu` |
| 豆包 | `doubao` |
| 通义千问 | `qwen` |
| Kimi | `kimi` |
| 文心一言 | `wenxin` |
| 自定义网关 | `custom` (兼容 OpenAI API) |

**关键函数**：
- `chatComplete({ model, messages, temperature, max_tokens, stream })` — 统一聊天接口

#### `src/providers/image.mjs` — 图像生成 (6 家)

| Provider | 说明 |
|----------|------|
| 智谱 CogView | `zhipu` |
| 通义万相 | `qwen` |
| 豆包 | `doubao` |
| 文心 | `wenxin` |
| OpenAI DALL-E | `openai` |
| OpenRouter / 302.ai | `openrouter` (chat 模态，支持 i2i) |

**关键函数**：
- `imageGenerate(prompt, { size, referenceImage })` — 统一图像生成接口

#### `src/providers/vision.mjs` — 视觉理解 (8 家)

| Provider | 说明 |
|----------|------|
| 智谱 GLM-4V | `zhipu` |
| OpenAI | `openai` |
| 通义 VL | `qwen` |
| 豆包 | `doubao` |
| Anthropic Claude | `anthropic` |
| Kimi | `kimi` |
| StepFun | `stepfun` |
| MiniMax | `minimax` |

#### `src/providers/asr.mjs` — 语音识别 (7 家)

| Provider | 说明 |
|----------|------|
| Google Gemini | `gemini` |
| OpenAI Whisper | `openai` |
| 通义 paraformer | `qwen` |
| Groq | `groq` |
| MiniMax | `minimax` |
| Azure Speech | `azure` |
| 豆包 | `doubao` |

#### `src/providers/tts.mjs` — 语音合成 (5 家)

| Provider | 说明 |
|----------|------|
| MiniMax | `minimax` |
| OpenAI | `openai` |
| Azure | `azure` |
| 豆包 | `doubao` |
| 通义 CosyVoice | `qwen` |

#### `src/providers/embedding.mjs` — 文本向量化 (4 家)

| Provider | 说明 |
|----------|------|
| OpenAI | `openai` |
| Google Gemini | `gemini` |
| 智谱 | `zhipu` |
| 通义 | `qwen` |

#### `src/web_search.mjs` — 联网搜索 (4 家)

| Provider | 说明 |
|----------|------|
| Tavily | `tavily` |
| Brave | `brave` |
| SerpAPI | `serpapi` |
| SearXNG | `searxng` |

**关键函数**：
- `shouldSearch(userMessage)` — 判断是否需要联网搜索
- `webSearch(query)` — 执行搜索
- `formatSearchContext(results)` — 格式化搜索结果注入 prompt
- `getActiveSearchProvider()` — 获取当前激活的搜索 Provider

---

### 4.9 安全与护栏层

#### `src/moderation.mjs` — 危机干预 + 冲突红线出站护栏

**职责**：
1. **危机干预**：检测到自伤信号 → 立即退出角色 → 给求助热线 → 冷战中也最高优先
2. **冲突红线**：绝不说分手/拉黑/威胁性告别 → 确定性出站扫描 → 不靠模型自觉
3. **情绪 repair**：冲突期禁止撒娇/照片/告白

**关键函数**：
- `detectCrisisSignals(text)` — 检测自伤/自杀信号
- `checkRedlineViolation(reply)` — 出站红线扫描
- `getSafetyStatus(companionId)` — 获取当前安全状态

#### `src/minor_guard.mjs` — 未成年人保护

**职责**：检测用户自曝未成年 → 粘性安全模式（朋友身份 / 无恋爱内容 / 照片中性化）。

**核心特性**：
- 无关闭开关（除非显式年龄声明解除）
- 双重检测：regex + LLM 兜底
- 影响范围：system prompt / 照片生成 / 关系阶段 / 表白禁止

#### `src/privacy_filter.mjs` — 隐私过滤

**职责**：所有长期存储入口统一挂载。过滤规则：
- 密码/证件/银行卡 → 整条不入库
- 手机号/住址 → 脱敏后入库
- 所有 `addMemory` / `addDiary` / `addThought` 等写入口统一经过

#### `src/persona_guard.mjs` — 人设一致性校验

**职责**：回复后校验，自动检测：
- "我是 AI" / "作为 AI 助手" 等穿帮话术
- 客服话术
- 阶段违规（如朋友阶段说情话）

轻度问题后处理修正；重度问题重生成。

#### `src/security/netguard.mjs` — SSRF 防护下载

**职责**：所有从用户 URL 下载的图片走此模块。防护措施：
- 仅 http/https
- DNS 解析后逐 IP 校验
- 拒绝 127/10/172.16-31/192.168/169.254/100.64/IPv6 ULA/link-local
- <= 5MB / <= 3 跳重定向 / 15s 超时

#### `src/ai_taste_guard.mjs` — AI 味防护

**职责**：检测和消除回复中的 AI 味特征（过于完整、过于礼貌、过于热情等）。

#### `src/inbound_dedup.mjs` — 入站消息去重

**职责**：微信协议层可能重推同一消息 → 基于消息 ID + 内容哈希去重。

#### `src/text_similarity.mjs` — 文本相似度

**职责**：提供文本相似度计算能力（Jaccard 等），被防复读、去重等模块共享使用。

---

### 4.10 数据访问层

#### `src/db.mjs` — SQLite 数据层

**职责**：所有数据库操作的唯一入口。使用 better-sqlite3 同步 API + WAL 模式。

**数据库文件**：`data/bot.db`（默认路径，可通过 `DB_PATH` 环境变量修改）

**性能配置**：
```javascript
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');    // 64MB page cache
db.pragma('mmap_size = 268435456');  // 256MB mmap
db.pragma('temp_store = MEMORY');
db.pragma('busy_timeout = 5000');
```

**初始化链**（每次 `getDb()` 调用时执行）：
```
initSchema() → migrateWechatAccounts() → migratePendingBindSessions()
→ migrateUsers() → migrateCompanionMemories() → migrateCompanions()
→ migratePollState() → migrateUserAccounts() → initAiUsageTable()
→ migrateCompanionMemoriesV2() → migrateDailyScheduleV2()
→ migrateConfessionFields() → initAvatarPresets() → migrateMemoryV3()
→ migrateEmotionState() → migrateProactiveEngineV2()
→ migrateEmotionHistory() → migrateP2Tables() → migrateDiary()
→ migrateReminderPush() → ... (共 30+ 迁移函数)
```

**关键表**（部分）：
| 表名 | 说明 |
|------|------|
| `users` | 用户账号 |
| `companions` | AI 角色 |
| `companion_memories` | 记忆 |
| `companion_emotion_state` | 情绪状态 |
| `companion_daily_schedule` | 每日日程 |
| `companion_diary` | 日记 |
| `companion_daily_thoughts` | 每日一句 |
| `companion_reminders` | 提醒 |
| `companion_shaping` | 共建留痕 |
| `companion_open_loops` | 开环 |
| `companion_time_capsules` | 时光胶囊 |
| `companion_sleep_schedule` | 作息 |
| `companion_visual_identity` | 视觉人设 |
| `relationship_event_log` | 关系事件流水 |
| `safety_events` | 安全事件 |
| `ai_usage` | AI 用量 |
| `wechat_accounts` | 微信绑定 |
| `app_settings` | 应用设置 |
| `annotation_corpus` | 标注语料 |

---

### 4.11 辅助与服务层

#### `src/reflection.mjs` — AI 反思引擎

**职责**：
- 每日 02:15：从最近聊天中提炼新记忆
- 每周日 02:45：回顾本周记忆，合并/更新

#### `src/diary.mjs` — 日记生成

**职责**：每晚生成第一人称内省日记。

#### `src/relational_diary.mjs` — 反向日记

**职责**：生成"今天与你有关的回忆"，从用户视角记录互动。

#### `src/thoughts.mjs` — 每日想对你说

**职责**：每天 02:35 生成一句独立于聊天的话，按想念档（0-4）调口吻。

#### `src/open_loops.mjs` — 开环记忆

**职责**：追踪"她记得的未完成的事"。用户说"明天面试"→ 第二天她主动问"面试咋样"；已完成的自动了结。

#### `src/time_capsule.mjs` — 时光胶囊

**职责**：用户写一段话设未来解锁时间，到期 cron 自动打开，她写感想。

#### `src/letter.mjs` — 留言胶囊

**职责**：她能给用户写带签名的离线信。

#### `src/persona_export.mjs` — 人设导入/导出

**职责**：Companion JSON 导出/导入（跨部署迁移）。运行状态（好感/情绪/安全模式）不随迁移。

#### `src/event_graph.mjs` — 事件图谱

**职责**：从记忆文本规则驱动自动提取实体和关系，不额外调用 LLM。

#### `src/achievements.mjs` — 成就系统

**职责**：里程碑检测（认识 100 天等），自动登记成就。

#### `src/backfill_history.mjs` — 互动历史自动打底

**职责**：创建即生成最近一周互动史；聊到第 10 条或绑微后补全到"认识三个月"。

#### `src/plan_tasks.mjs` — Cron 定时任务

**职责**：日/周/月定时任务调度。

| 时间 | 任务 |
|------|------|
| 00:30 | 生成每日日程 |
| 02:00 | 长期记忆摘要 |
| 02:15 | 记忆反思提炼 |
| 02:20 | 日记生成 |
| 02:35 | 每日一句 |
| 02:45 (周日) | 每周反思 + 周日记 |
| 02:50 (周日) | 每周日记 |
| 03:00 (每月1号) | 月记合并 |
| 03:20 | 记忆衰减 |
| 每小时 | 历史清理 (60 天) / proactive 死人开关 |

#### `src/ilink.mjs` — iLink 协议封装

**职责**：封装腾讯 iLink/ClawBot 协议：
- `getUpdates(ctx, buf)` — 长轮询消息
- `notifyStart(ctx)` — 心跳在线
- `sendMessage(ctx, msg)` — 发送消息
- `getBotQrcode(ctx)` — 获取绑定二维码
- `getQrcodeStatus(ctx)` — 查询扫码状态
- `startIlinkSendDrainLoop()` — 发送限速队列 drain loop

#### `src/auth.mjs` — 认证

**职责**：JWT Token 签发/验证、用户注册/登录、验证码。

#### `src/admin.mjs` — 管理员系统

**职责**：管理员密码管理（首次启动自动生成 20 位写入 `.admin-credentials`）、管理员 Token 签发/验证。

#### `src/email.mjs` — 邮件

**职责**：验证码邮件发送 / 管理员告警邮件。

#### `src/logger.mjs` — 日志

**职责**：统一日志输出，支持不同级别（debug/info/warn/error）。

#### `src/ratelimit.mjs` — 限流

**职责**：API 频率限制，按个人量级设计。

#### `src/stickers.mjs` — 表情包

**职责**：按情绪 tag 匹配发送表情包（仓库不含素材，需自备）。

#### `src/user_profile.mjs` — 用户画像

**职责**：结构化用户信息管理。

#### `src/provider_costs.mjs` — 用量成本估算

**职责**：基于 Provider 定价配置估算 API 调用成本（后台自填，不硬编码价格）。

#### `src/arc_log_sink.mjs` — 弧事件日志

**职责**：冲突弧事件记录与日志输出。

---

## 5. 前端架构

### 技术栈

- 原生 HTML/CSS/JS（无框架）
- Glassmorphism 液态玻璃 UI（[glass.css](file:///d:/b项目/xiyu-ai/public/app/glass.css)）
- PWA 支持（[sw.js](file:///d:/b项目/xiyu-ai/public/sw.js) + [manifest.webmanifest](file:///d:/b项目/xiyu-ai/public/manifest.webmanifest)）
- 国际化（[i18n.js](file:///d:/b项目/xiyu-ai/public/app/i18n.js)）
- 主题切换（[theme.js](file:///d:/b项目/xiyu-ai/public/app/theme.js)，自动/浅色/深色）

### 页面清单 (17 个)

| 路径 | 页面 | 功能 |
|------|------|------|
| `/` | [index.html](file:///d:/b项目/xiyu-ai/public/index.html) | 官网落地页 |
| `/app/setup.html` | setup | 首次配置向导（选 Provider + 测试连通） |
| `/app/auth.html` | auth | 邮箱注册/登录 |
| `/app/create.html` | create | 4 步创建 AI 角色向导 |
| `/app/dashboard.html` | dashboard | 主控制台（好感度/关系阶段/情绪/设置抽屉） |
| `/app/playground.html` | playground | 浏览器聊天 + 录音 + 朗读 |
| `/app/memories.html` | memories | 记忆管理（筛选/增删改查/置顶/锁定） |
| `/app/diary.html` | diary | 日记翻书阅读 + 按句朗读 |
| `/app/bind.html` | bind | 扫码绑定微信 |
| `/app/admin.html` | admin | 管理员后台 |
| `/app/admin-user-profile.html` | admin-user-profile | 管理员查看用户资料 |
| `/app/emotion-debug.html` | emotion-debug | 情绪调试面板（弧状态/事件流水/情绪增量） |
| `/app/annotate.html` | annotate | 样本标注工具（好/坏 + tag） |
| `/app/debug-prompt.html` | debug-prompt | 调试提示词 |
| `/app/forgot.html` | forgot | 忘记密码 |
| `/app/privacy.html` | privacy | 隐私政策（模板） |
| `/app/terms.html` | terms | 用户协议（模板） |
| `/app/upgrade.html` | upgrade | 升级/付费（占位） |
| `/app/verify-letter.html` | verify-letter | 验证身份 |

---

## 6. 数据库设计

### 核心表关系

```
users (用户账号)
  └── companions (AI 角色)  [1:N]
        ├── companion_memories (记忆)  [1:N]
        ├── companion_emotion_state (情绪状态)  [1:1]
        ├── companion_emotion_history (情绪历史)  [1:N]
        ├── companion_daily_schedule (日程)  [1:N]
        ├── companion_daily_summary (摘要)  [1:N]
        ├── companion_diary (日记)  [1:N]
        ├── companion_daily_thoughts (每日一句)  [1:N]
        ├── companion_reminders (提醒)  [1:N]
        ├── companion_shaping (共建留痕)  [1:N]
        ├── companion_open_loops (开环)  [1:N]
        ├── companion_time_capsules (时光胶囊)  [1:N]
        ├── companion_sleep_schedule (作息)  [1:1]
        ├── companion_visual_identity (视觉人设)  [1:1]
        ├── relationship_event_log (关系事件流水)  [1:N]
        └── companion_proactive_last_sent (主动消息记录)  [1:N]

wechat_accounts (微信绑定)
  └── companion_id → companions.id

ai_usage (AI 用量)
  └── companion_id → companions.id

safety_events (安全事件)
  └── companion_id → companions.id

annotation_corpus (标注语料)
  └── companion_id → companions.id
```

### Schema 迁移策略

- 渐进式：每次加新功能即添加 `migrateXxx()` 函数
- 幂等：所有 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` 加存在性检查
- 启动时自动执行：`getDb()` 调用时顺序执行全部迁移函数

---

## 7. 依赖关系图

### 模块依赖（核心）

```
index.mjs
├── db.mjs (初始化)
├── ilink.mjs (轮询池)
├── bot.mjs (消息处理)
│   ├── ai.mjs → providers/chat.mjs
│   ├── companion.mjs
│   │   ├── memory_v2.mjs → db.mjs
│   │   ├── emotion_state.mjs → db.mjs
│   │   ├── sleep.mjs → db.mjs
│   │   ├── shaping.mjs → db.mjs
│   │   ├── open_loops.mjs → db.mjs
│   │   ├── relationship_arc_runtime.mjs
│   │   └── user_profile.mjs
│   ├── memory_v2.mjs → providers/embedding.mjs
│   ├── moderation.mjs
│   ├── minor_guard.mjs
│   ├── persona_guard.mjs
│   ├── privacy_filter.mjs
│   ├── inner_os.mjs → ai.mjs
│   ├── photo_intent.mjs
│   ├── photo_planner.mjs
│   ├── photo_sender.mjs → providers/image.mjs → media.mjs
│   ├── sleep.mjs
│   ├── escalation.mjs
│   ├── inbound_dedup.mjs
│   └── shaping.mjs
├── api.mjs (Express 路由)
│   ├── auth.mjs / admin.mjs
│   ├── ratelimit.mjs
│   ├── companion.mjs
│   ├── memory_v2.mjs
│   ├── emotion_state.mjs
│   ├── persona_export.mjs
│   ├── ai.mjs
│   ├── sleep.mjs
│   ├── photos_*.mjs
│   ├── voice_*.mjs
│   └── web_search.mjs
├── proactive.mjs → proactive_engine.mjs → proactive_material.mjs
├── plan_tasks.mjs
│   ├── reflection.mjs
│   ├── diary.mjs
│   ├── thoughts.mjs
│   ├── sleep.mjs
│   ├── time_capsule.mjs
│   └── proactive_deadman.mjs
└── security/netguard.mjs
```

### NPM 依赖

| 包 | 用途 |
|----|------|
| `express` ^5.2.1 | Web 框架 |
| `better-sqlite3` ^11.0 | SQLite 数据库 |
| `dotenv` ^16.4 | 环境变量加载 |
| `node-fetch` ^3.3 | HTTP 请求 |
| `openai` ^4.67 | OpenAI SDK |
| `@google/generative-ai` ^0.21 | Google Gemini SDK |
| `@tencent-weixin/openclaw-weixin-cli` ^2.1 | 微信 iLink CLI |
| `sharp` ^0.34 | 图像处理 |
| `wx-voice` ^0.2 | 微信语音处理 |
| `qrcode` ^1.5 | 二维码生成 |
| `qrcode-terminal` ^0.12 | 终端二维码 |
| `form-data` ^4.0 | 表单数据 |
| `eslint` ^10.4 (dev) | 代码检查 |

---

## 8. 项目运行方式

### 方式 A：Docker Compose（推荐生产）

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
docker compose up -d
# 打开 http://localhost:3000/app/setup.html
```

- SQLite 数据走 `./data` volume，重启不丢
- `restart: unless-stopped` 已内置
- 自定义端口：`HOST_PORT=8080 docker compose up -d`

### 方式 B：一行 Docker Run

```bash
docker run -d -p 3000:3000 -v xiyu-data:/app/data \
  --name xiyu-ai ghcr.io/dimang01/xiyu-ai:latest
```

### 方式 C：本地裸跑（推荐开发）

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
# 前置：Node.js >= 20, npm
npm install
npm run setup      # 生成 .env + 预检编译工具链
npm start          # 启动服务 → http://localhost:3000
```

### 启动后流程

```
1. 打开 http://localhost:3000
2. 访问 /app/setup.html  → 选择 Provider 并填入 API Key
3. 访问 /app/auth.html    → 注册账号（dev 模式验证码打印到日志）
4. 访问 /app/create.html  → 4 步创建 AI 角色
5. 选聊天入口：
   - /app/playground.html  浏览器内聊天
   - /app/bind.html        扫码绑定微信（需 iLink 准入）
6. 访问 /app/dashboard.html → 查看状态
```

### 关键环境变量

| 变量 | 说明 | 必须 |
|------|------|------|
| `CHAT_PROVIDER` | 聊天 Provider | 是 |
| `CHAT_API_KEY` | 聊天 API Key | 是 |
| `AUTH_SECRET` | JWT 签名密钥 (>= 32 字符) | 生产建议 |
| `DB_PATH` | 数据库路径 | 否 (默认 data/bot.db) |
| `SINGLE_USER` | 单用户模式 | 否 |
| `TRUST_PROXY` | Express trust proxy | 反代时建议 |
| `ILINK_BOT_TOKEN` | 微信 Bot Token | 使用微信时 |
| `ILINK_BOT_ID` | 微信 Bot ID | 使用微信时 |

---

## 9. 脚本与工具链

### NPM Scripts

```bash
npm start             # 启动服务
npm run dev           # 开发模式（文件变更自动重启）
npm run setup         # 首次配置向导
npm run ilink:login   # 微信扫码登录
npm run doctor        # 一键诊断
npm run lint          # 代码检查
npm run check:p0      # P0/P1 回归测试（127 项）
npm run check:imports # ESM 循环依赖检查
npm run arc:digest    # 运营日报
npm run smoke         # Release smoke 测试
```

### 诊断/运维脚本（`scripts/` 目录）

| 脚本 | 用途 |
|------|------|
| `doctor.mjs` | 一键诊断（Node/SQLite/Key/iLink/端口/服务） |
| `arc-digest.mjs` | 运营日报（错误签名归并/关系事件/红线触发） |
| `p0_regression_check.mjs` | P0/P1 回归 127 项 |
| `export-corpus.mjs` | 导出标注语料 JSONL |
| `backup-db.sh` / `restore-db.sh` | 数据库备份/恢复 |
| `opensource_check.sh` | 6 项开源合规检查 |
| `ai_taste_scan.mjs` | AI 味扫描 |
| `retention_dashboard.mjs` | 留存仪表盘 |

---

## 10. 扩展与定制

### 添加新的 Chat Provider

1. 在 `src/providers/chat.mjs` 中向 `REGISTRY` 添加新条目
2. 实现 `chatComplete` 的内部 dispatch 逻辑
3. Setup Wizard 页面会自动读取 REGISTRY 展示新 Provider
4. 无需修改 `src/ai.mjs` 或 `src/bot.mjs`

### 添加新的主动消息类型

1. 在 `src/proactive.mjs` 中添加新的 `effectiveKind`
2. 在 `src/proactive_engine.mjs` 中定制 motivation 计算
3. 在 `src/proactive_material.mjs` 中添加素材生成逻辑

### 添加新的安全护栏

1. 在 `src/moderation.mjs` 中添加检测逻辑
2. 在 `src/bot.mjs` 的 `handleMessage()` pipeline 中挂载
3. 在 `src/db.mjs` 中按需添加记录表

### 自定义前端主题

- 修改 `public/app/glass.css` 中的 CSS 变量调整液态玻璃效果
- 修改 `public/app/theme.js` 中的配色方案
- 所有页面通过共享的 CSS/JS 文件统一风格

---

> **文档生成时间**：2026-06-11 | **基于版本**：v1.21.4  
> 仓库：[github.com/dimang01/xiyu-ai](https://github.com/dimang01/xiyu-ai)