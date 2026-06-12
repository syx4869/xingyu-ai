# 星语 AI 变更日志

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
