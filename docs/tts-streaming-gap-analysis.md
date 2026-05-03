# TTS 流式播放卡顿问题分析与解决

## 问题描述

使用 Hanako 的 TTS 功能（火山引擎流式合成）朗读文本时，听感不自然：
- 字与字之间有几毫秒的间断感，像发音被「抠掉」了
- 或者每个音节之间有微小的中断

此问题在单次播放完整 MP3 文件（如自建 DoBao-TTS）时不存在，确认是**流式合成特有的问题**。

---

## 排查过程

### 阶段一：怀疑播放器调度间隙

**假设**：AudioBufferSourceNode 的链式 `onended` 回调之间存在调度延迟。

**尝试**：
1. 加 3 块 jitter buffer → 有所改善但不彻底
2. 改用 `start(when)` 绝对时间调度 → 改善有限
3. 确认问题不在「块间间隙」，而在「每个字之间」

**结论**：不是播放器调度问题。❌

### 阶段二：怀疑采样率不匹配

**假设**：火山引擎返回 24000Hz MP3，AudioContext 默认用系统 48000Hz，实时重采样引入 artifacts。

**尝试**：固定 AudioContext sampleRate 为 24000Hz。

**结果**：无明显改善。❌

### 阶段三：怀疑 PCM 拼接边界

**假设**：每个 chunk 独立解码时，MP3 解码器对每段独立处理 encoder delay/padding，导致 chunk 衔接处有微小 discontinuity。

**尝试**：将 8 个 chunk 的 PCM 数据合并成一个 AudioBuffer 播放。

**结果**：刘欢确认「不是你改的这个问题」，问题在音源本身。❌

### 阶段四：定位到根本原因

**发现**：查阅社区资料（dev.to 文章 "Solving Audio Gaps in Real-Time Speech Translation"），确认流式 TTS 引擎（Nvidia Riva、火山引擎等）在合成时，**每个 SSE chunk 的首尾会自动添加几毫秒的静音 padding**。这些 padding 在 Audacity 中可见为 20-50ms 的静音间隙，且不是完美的零值，而是低振幅噪声（0x01, 0x02）。即使每 8 个 chunk 合并，padding 仍然存在于合并块内部，表现为字间中断。

**根因确认**：✅ 每个 chunk 首尾的静音 padding 在连续播放时累积为字间微中断。

---

## 最终解决方案

### 方案一：Silence Trimming（核心）

对每个解码后的 AudioBuffer，用阈值检测裁掉首尾的近零静音。

- 阈值：`0.001`（Float32，约等于 16-bit PCM 的 ±33）
- 保留边缘：`8ms`（保护字尾的自然衰减，防止「抢着说」听感）

阈值太低会切到正常语音的尾音，太高则去不掉 padding。8ms 保留边缘保证元音的尾音衰减不被截断。

### 方案二：PCM 合并

每 8 个裁剪后的 chunk 合并为一个 AudioBuffer 播放，将边界数量减少 8 倍。

### 方案三：绝对时间调度

用 `AudioBufferSourceNode.start(when)` 替代链式 `onended` 回调，消除回调调度间隙。

### 方案四：固定采样率

AudioContext 创建时指定 `sampleRate: 24000`，与火山引擎输出匹配，跳过实时采样率转换。

---

## 改动文件

| 文件 | 改动 |
|------|------|
| `desktop/src/services/tts-player.ts` | 新增 `_trimSilence` 方法；enqueue 中先裁剪再入队；MERGE_COUNT=8；PCM 合并；start(when) 调度；固定 24000Hz |
| `desktop/src/react/services/ws-message-handler.ts` | `tts_audio_done` 分支调用 `player.flush()` |

---

## 效果

- 字间中断：✅ 消除
- 自然尾音：⚠️ 需平衡阈值，当前参数 0.001 + 8ms 边缘效果良好
- 播放延迟：无明显增加（前 8 块到达约需 100-200ms，随后持续播放）

---

## 后续可优化方向

1. **交叉淡入淡出**：在合并块之间做 5ms 的 linear crossfade，进一步消除偶发边界 artifacts
2. **动态阈值**：根据音频块的实际振幅动态计算裁剪阈值，适应不同音量和音色
3. **后处理降噪**：对整段 PCM 做轻量的降噪处理，进一步提升音质
4. **切换到自建 DoBao-TTS**：非流式完整 MP3 播放可完全规避该问题
