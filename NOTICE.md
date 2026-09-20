# NOTICE —— 来源与改动说明

本包是 **dsh-whale-girl-pet 0.3.2** 的修改版（fork）。

## 上游

| | |
|---|---|
| 包名 | `dsh-whale-girl-pet` |
| 版本 | 0.3.2 |
| 作者 | yanzwzz |
| 仓库 | https://github.com/yanzwzz/dsh-whale-girl-pet |
| 许可证 | MIT（见 `LICENSE`，版权归原作者） |

按 MIT 的要求，`LICENSE` 原样保留、版权声明未改动。本文件用于说明**改了哪些地方**，便于区分责任：上游代码的问题请找上游，下面这些改动引入的问题找本 fork 的维护者。

## 本 fork 的改动清单

### 1. 修复：天气 / 余额 / 今日用量「无法获取」
- **原因**：两者都交给 `ctx.shell` 跑 PowerShell 出网，而插件会把**当前会话的沙箱策略**解析出来强行覆盖到 shell 调用上（`reqSpec.sandboxPolicy = policy`）。会话策略是 `workspace-write` / `read-only` 时出网命令被拦；审批策略为「从不询问」时连审批都不弹、命令直接失败 —— 于是三个功能一起挂。
- **改法**：改为**宿主进程内 `node:fetch` 优先**（宿主不受文件沙箱限制），并停止覆盖 `sandboxPolicy`；PowerShell 仅作为兜底保留（`/api/whale-pet/weather-shell`）。涉及 `lib/index.js`。
- **顺带**：`resolveApiKey()` 增加读 `$DSH_HOME/.credentials.yaml` 的 `refs:` 段作为凭据服务之外的兜底。

### 2. 新增：桌宠大小调整
- 设置面板加了滑块 / ±档位 / 预设（180·260·360·480）/ 重置；宠物右下角加了**拖拽缩放手柄**。
- 新的设置键 `size`（80–600px）。按钮尺寸/间距/位置改由 `--wb-scale` 派生，随桌宠等比缩放；按钮改为**鼠标移入才显示**（查询中 / 看板打开 / 拖拽时保持可见，触屏常显）。
- 涉及 `lib/client.js`（新增 `.dsh-pet-resize`、`.wb-stack` 的 `--wb-scale` 与 hover 规则）。

### 3. 新增：任务播报语音（角色音色）
- 新增 `lib/edge-tts.js`：**零依赖**的 Edge 神经网络 TTS 客户端（自己实现 WebSocket 握手与帧解析、`Sec-MS-GEC` 令牌、语音清单）。上游包原本没有任何运行时依赖，本 fork 保持这一点。
- 新增路由 `GET /api/whale-pet/voices`、`POST /api/whale-pet/say`。
- 内置 16 个角色音色预设（`VOICE_CHARACTERS`）：胡桃 / 派蒙 / 钟离 / 纳西妲 / 可莉 / 芙宁娜 / 雷电将军 / 甘雨 / 魈 / 七七 / 东北大姨 / 陕西妹子 / 港风女声 / 台湾软妹 / 清爽少年 / 正经播报。
- **不是声优录音**，而是"Edge 神经网络音色 + 音调语速"的近似；设置面板可选底层音色并自调音调/语速。
- 合成失败自动退回浏览器内建 `speechSynthesis`（有网络依赖，但降级后仍会出声）。
- 新增配置键：`voiceEnabled` / `voiceCharacter` / `voicePitchVoice` / `voicePitch` / `voiceRate` / `voiceEngine`。

### 4. 修复：完成提示被 4 秒时间冷却吞掉
- 原实现用 `now - lastAgentIdleAt < 4000` 去重，连续跑两个任务时第二个不播报。
- 改为按**回合号**（`turn/start`、`turn/end` 提供）去重：一轮只报一次，连续任务不会被吞。

### 5. 修复：中断播报从未生效
- 原实现监听 `ctx.on('agent/abort', ...)`，但 **DSH 并没有这个事件**（`agent/status` 只有 `idle` / `running`）。
- 改用 `session/event` 的 `turn/end { reason.kind: 'aborted' }` 作为唯一可靠信号。

### 6. 其他
- 播报内容带上**任务名**：取本轮第一条人类提问（`user/message` 且 `source === 'human'`，`agent.inject()` 的合成上下文不算），24 字截断，任务结束即清空。
- `README.md` 增补上述功能、配置项与踩坑记录。

## 未改动

- `assets/` 下全部动画与预览素材。
- `lib/usage.js`、`lib/usage-ledger.js`、`lib/cost-projection.js`（计费与用量内核）。
- `LICENSE`。
