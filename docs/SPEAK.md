# 说话（TTS）

宿主的 `send_voice` 指向本网关之后，机器人**所有**语音请求都会打到 `/v1/audio/speech`。
这个端点因此同时承担两件事：

| 输入 | 走什么 | 耗时（RTX 3080，常驻换声） |
|---|---|---|
| 含点歌意图（`唱：歌名`、`点歌唱…`、句中触发） | 换声唱歌（GPU，整首自动分段） | 12 秒（45 秒成品）/ 22 秒（整首 3:54） |
| 其它文本 | **说话**（下面的 `say` 引擎） | **3 秒**（首句 12-13 秒，要加载换声模型） |

> 唱歌那条路见 [TUNING.md](TUNING.md)；这里只讲"说话"。

## 三档引擎

配置在 `gateway/config.json` 的 `say.engine`：

| 引擎 | 拟人度 | 一句耗时 | 需要 |
|---|---|---|---|
| `windows` | 😑 机械（SAPI Huihui/Yaoyao/Kangkang） | 0.6 秒 | 无，系统自带 |
| **`edge`（默认）** | 🙂 **接近真人**（微软神经语音） | 2-3 秒 | 联网 + `edge-tts` |
| 任意 + `postVoice: true` | 🙂 语气来自 TTS、**音色是你的** | +1-3 秒（常驻） | 额外跑一遍 RVC |

Windows 自带的 SAPI 只有三代老语音，"自然语音"包只提供给"讲述人"、程序里拿不到，
所以想拟人就走 `edge`。

## 配置

```json
"say": {
  "engine": "edge",                        // edge | windows | none
  "voice": "zh-CN-XiaoxiaoNeural",         // 见下面「音色」
  "python": "E:/Cache/qq-agent/tts-venv/Scripts/python.exe",   // 装了 edge-tts 的解释器
  "rate": 0,                               // -10~10（edge 映射成 ±10%）
  "pitch": 0,                              // -200~200 Hz（仅 edge）
  "volume": 100,
  "maxChars": 800,                         // 超长截断（宿主本身只给 300 字左右）
  "timeoutMs": 60000,
  "postVoice": false,                      // true = TTS 后再过一遍换声，用你的音色
  "postVoiceModel": ""                     // 留空 = voice.defaultVoice
}
```

## 安装 edge-tts（一次就好）

```powershell
python -m venv E:\Cache\qq-agent\tts-venv
E:\Cache\qq-agent\tts-venv\Scripts\python.exe -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple edge-tts
```

> 直连 PyPI 在国内常会卡死，用清华源 40 秒装完。

列可用音色：

```powershell
E:\Cache\qq-agent\tts-venv\Scripts\python.exe -m edge_tts --list-voices
```

### 常用中文音色

| 语音名 | 特点 |
|---|---|
| `zh-CN-XiaoxiaoNeural` | 晓晓，温柔自然（默认） |
| `zh-CN-XiaoyiNeural` | 晓伊，更活泼、少女感 |
| `zh-CN-YunxiNeural` | 云希，男声 |
| `zh-CN-YunyangNeural` | 云扬，男声，播音腔 |
| `zh-CN-liaoning-XiaobeiNeural` | 东北话 |
| `zh-CN-shaanxi-XiaoniNeural` | 陕西话 |

## 用你的音色说话（`postVoice`）

**RVC 不能纯文字生成语音** —— 它是"声音转换"：输入是音频（决定说什么），只换音色。
所以必须两段式：

```
文字 ──edge TTS（决定说什么）──► 音频 ──RVC（换成你的音色）──► 语音条
```

打开 `say.postVoice: true` 即可。开了之后：

- 音色是你的，但**语气/节奏仍来自 TTS**（想要连语气都像你，得训一个真 TTS 模型，
  例如 GPT-SoVITS / Bert-VITS2 / CosyVoice，那是另一个量级的工程，本仓库不做）
- 换声走**常驻进程**（见 [TUNING.md](TUNING.md) 的「常驻换声」），所以一句只多 1-3 秒；
  常驻进程没起来时第一句会多 10 秒左右
- 换声失败会**自动退回 TTS 原声**，不会因为换声挂了就发不出语音

## 故障与注意

| 现象 | 原因 / 处理 |
|---|---|
| `say.engine = edge` 但语音还是机械的 | 没装 edge-tts 或 `say.python` 指错 → 看网关日志 `[say] Edge 合成失败，退回系统语音` |
| 发声很慢（10 秒以上） | 常驻换声进程没起来（`voice.serveCommand` 为空或启动失败）→ 日志里找 `[voice] 常驻换声进程已启动` |
| 宿主报 `HTTP 524` | 语音条通道走了 Cloudflare 快速隧道（约 100 秒限制）→ 改用本机 8898 专线，见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| 说话没声音 / 音频极小 | 检查 `maxChars`（别设太小）与网关日志里的 `[say] N 字 → M 秒` |

`/health` 里能直接看到当前引擎：`"say": "edge"` / `"windows"` / `"none"`。
