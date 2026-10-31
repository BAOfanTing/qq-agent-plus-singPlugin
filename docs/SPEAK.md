# 说话（TTS）

宿主的 `send_voice` 指向本网关后，机器人**所有**语音请求都会打到 `/v1/audio/speech`：

| 输入 | 走什么 | 耗时（实测） |
|---|---|---|
| 含点歌意图（`唱：歌名`、`点歌唱…`、句中触发） | 换声唱歌（本机 GPU，整首自动分段） | 12 秒（45 秒成品）/ 22 秒（整首 3:54） |
| 其它文本 | **说话**：Breeze TTS 2 云端（`api.breeze.blue`） | **3-6 秒** |

唱歌那条路见 [TUNING.md](TUNING.md)。这里只讲"说话"。

## 为什么只用 Breeze 云端

| 方案 | 音质 | 占显存 | 成本 | 结论 |
|---|---|---|---|---|
| Windows SAPI（系统语音） | 机械，没法听 | 0 | 免费 | ❌ 已删 |
| Edge TTS（edge-tts） | 接近真人 | 0 | 免费 | ❌ 已删（要多装一套 Python 环境，音色也固定） |
| **Breeze TTS 2 云端** | 开源权重里最好（官方 #1），50 个音色 | **0** | 按字符计费 | ✅ **当前方案** |
| Breeze 本地权重 | 同上 | 7.7 G | 免费但要下 7 GB | ⏸ 可选（和唱歌抢显存） |

云端最大的好处：**不占显卡**，所以唱歌（RVC）和说话可以同时用，不需要互斥调度。

## 插件里配（推荐）

控制台 → 插件 → 点歌唱歌 → **「说话（Breeze 云端）」** 分组：

| 设置 | 说明 |
|---|---|
| **Breeze API Key** | `brz_xxxx`，在 Breeze 控制台 → API Keys 生成。加密保存在宿主，不回显明文 |
| **音色 id** | 如 `voc_8yud7hz7c9q2`（大肥鱼·迷糊版）。不知道 id 就群里问「列出说话音色」 |

填完立刻生效（插件把值推给网关 `POST /say/config`，网关落盘，重启也在）。

**插件页会显示后端状态**：点「检测登录」或让机器人跑一次，徽标会显示
「说话后端在线（额度 1362）」或「说话后端离线：API Key 不对」。

## 音色怎么查

```bash
# 网关侧（用网关令牌）
curl -H "authorization: Bearer <网关令牌>" https://<网关地址>/say/voices

# 或直连 Breeze
curl -H "xi-api-key: brz_xxx" https://api.breeze.blue/v1/voices
```

群里也可以直接问「**有哪些说话音色**」→ 机器人调 `say_voices`（支持按名字过滤）。

## 网关侧配置（`gateway/config.json`）

```json
"say": {
  "engine": "breeze",                        // breeze | none
  "breezeUrl": "https://api.breeze.blue",
  "breezeKey": "brz_xxxx",                   // 插件填过就以插件为准
  "voiceId": "voc_8yud7hz7c9q2",
  "breezeModel": "breeze-tts-2",
  "languageCode": "zh",
  "instructions": "",                        // 可选：语气/情绪/节奏，用中文写
  "guidanceScale": 4.0,                      // 可选：指令遵循强度
  "outputFormat": "mp3_24000_128",
  "maxChars": 800,                           // 超长截断（宿主本身只给 300 字左右）
  "timeoutMs": 120000
}
```

接口形状（官方 `openapi.json`，ElevenLabs 风格）：

```
POST {baseUrl}/v1/text-to-speech/{voiceId}?output_format=mp3_24000_128&delivery=sync
header: xi-api-key: <key>          ← 不是 Bearer
body:  { text, model_id, language_code?, instructions?, voice_settings: { guidance_scale } }
→ 200 audio/mpeg
```

## 网关给插件用的三个接口

| 接口 | 用途 |
|---|---|
| `GET /say/status` | `{ online, hasKey, hasVoice, voiceId, balance, note }` —— 插件页"后端在线"就是它 |
| `GET /say/voices` | 音色列表（转发 Breeze） |
| `POST /say/config` | `{ apiKey?, voiceId? }` 插件推配置上来；空值表示"别改这一项" |

## 计费与限制

实测约 **0.186 额度/字符**（36 字扣 6.7）。免费注册送 1400 额度 → 约 **250 句**短话。

免费版（`/v1/entitlements`）：

| 项 | 值 |
|---|---|
| 并发 | 2 |
| 可保存音色 | 5 |
| **商用** | `commercial_use_allowed: false` ← 官方许可仅研究/非商用 |

查余额：`curl -H "xi-api-key: brz_xxx" https://api.breeze.blue/v1/balance`

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `说话后端离线：API Key 不对` | `xi-api-key` 的值要完整（带 `brz_` 前缀）；确认 Key 没被禁用/撤销 |
| 机器人还是发文字 | 插件设置里 Key/音色填了没；再看网关日志里有没有 `[say] N 字 → M 秒` |
| `Breeze 返回 402/429` | 额度不足或撞频率限制 → 查 `/v1/balance` |
| 宿主报 `HTTP 524` | 语音条通道走了 Cloudflare 快速隧道（约 100 秒限制）→ 改本机 8898 专线，见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| 机器人唱不了歌 | 那是唱歌链路，看 [TUNING.md](TUNING.md) |

`/health` 里能看到当前引擎：`"say": "breeze"`。
