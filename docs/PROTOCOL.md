# 插件 ↔ 网关 HTTP 契约（v1）

想自己实现后端（比如直接接 RVC WebUI、接商业 API、接你家里的另一台机器），只需要满足这份契约。
插件侧的所有请求都会带 `Authorization: Bearer <token>`（除非网关令牌留空）。

- 基础地址：插件设置里的「网关地址」，例如 `https://sing.example.com`（**必须 https**，不带结尾斜杠）
- 编码：`application/json; charset=utf-8`
- 错误约定：非 2xx 一律返回 `{ "ok": false, "message": "给人看的一句话" }`

## GET /health

**免鉴权**（方便排查隧道通不通），只暴露"在不在、什么引擎"：

```json
{ "ok": true, "version": "1.0.2",
  "engine": "command", "say": "windows", "voiceConfigured": true, "voices": ["hanser"],
  "source": "netease", "transcode": "auto", "jobs": 0,
  "voiceSeconds": 0, "voiceFullSong": true, "voiceMaxSeconds": 600, "jobMaxSeconds": 600 }
```

- `engine` / `voices` —— 换声引擎与可用音色（`engine: "none"` 表示没接换声，只能搬运音源）
- `say` —— 说话引擎（`windows` = 系统自带语音；`none` = 关掉）
- `voiceSeconds` —— 语音条当前生效时长（`0` + `voiceFullSong: true` = 整首）
- `voiceMaxSeconds` / `jobMaxSeconds` —— 两道上限，插件推的值会被它们夹住

## GET /search?q=<关键词>&limit=5

```json
{ "ok": true, "items": [
  { "id": "1440833098", "title": "孤勇者", "artist": "陈奕迅",
    "durationSec": 256, "source": "itunes" }
] }
```

`id` 由网关自定义（iTunes 用 trackId，local 用文件名）；空结果是 `items: []`，不是错误。

## POST /sing

```json
{ "song": "孤勇者 陈奕迅", "voice": "me", "maxSeconds": 60, "id": "(可选)直接指定条目" }
```

立刻返回 202，**不阻塞**：

```json
{ "ok": true, "jobId": "9f2c1a4b7d0e3f68", "state": "queued", "engine": "command" }
```

## GET /jobs/<jobId>

```json
{ "ok": true, "jobId": "9f2c...", "state": "running", "progress": 0.35,
  "title": "孤勇者", "artist": "陈奕迅", "engine": "command", "voice": "me",
  "audioUrl": "", "bytes": 0, "seconds": 0, "message": "换声" }
```

- `state`：`queued` / `running` / `done` / `failed`（插件只认这四个，其他值按 `failed` 处理）
- 完成时：`state: done`，`audioUrl` 给**相对或绝对**地址都行（相对地址按网关地址拼）
- 失败时：`ok: false`，带 `message` 或 `error`；插件会把这句话原样转给模型

```json
{ "ok": true, "state": "done", "progress": 1, "audioUrl": "/files/out-9f2c.mp3",
  "bytes": 812345, "seconds": 60, "title": "孤勇者", "artist": "陈奕迅", "engine": "command" }
```

## GET /files/<name>

返回音频字节（`audio/mpeg` / `audio/wav` / `audio/mp4`…）。插件用它把成品下载到自己的
`plugin-data/sing/media/`，再用 `cap.send.file` 发到群里。

- 文件保留 `filesTtlHours` 小时（默认 24），过期的会被网关自己清掉；
- 生命周期：插件下载完就可以删了，网关不依赖"插件一定来下载"。

## POST /v1/audio/speech

**给宿主用的**（不是给插件用的）：宿主的 `send_voice` 工具把文字发过来，要一段音频字节。
所以这个端点同时承担两件事：

| 输入 | 行为 | 响应 |
|---|---|---|
| 含点歌意图（`唱：歌名`、`点歌唱…`、句中触发） | 走换声流水线（同步等成品，整首会自动分段） | 音频字节 + `x-audio-seconds` |
| 其它文本 | 走 `say` 引擎（Windows 自带语音） | 音频字节 + `x-audio-seconds` |

```http
POST /v1/audio/speech
Authorization: Bearer <token>
Content-Type: application/json

{ "input": "唱：夜曲", "voice": "hanser", "maxSeconds": 0 }
```

响应头里的 `x-audio-seconds` 是**真实时长**：宿主默认是按字数估（4 字 → 1 秒），
拿到这个头就会显示真实值（否则 90 秒的翻唱会被说成"才一秒"）。

**请求是同步的**（几十秒起步）：别把它放在 100 秒就掐的通道后面（Cloudflare 快速隧道会回 524），语音条应走本机专线或 named tunnel（见 docs/TUNNEL.md）。

失败语义：换声失败 → 500 + 人能读的原因；`say.engine = none` 且不是点歌 → 400（宿主会退回文字）。

## 为什么要异步

宿主给插件工具的超时默认 3 分钟（本插件 `sing_song` 声明 300 秒）。整首 4 分钟的歌分段换声（每段 30 秒、模型只加载一次）在 3080 上约 82 秒，
通常 20-60 秒，CPU 上可能好几分钟 —— 同步接口会让调用方卡在超时上，还看不到进度。
所以：**提交拿 jobId → 每 1-2 秒问一次 → 完成再下载**。插件在轮询到 `180s - 20s` 时会主动放弃并
回一句"歌太长或电脑在忙"，而不是让宿主硬杀进程。
