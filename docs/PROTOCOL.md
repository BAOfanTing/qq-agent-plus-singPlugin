# 插件 ↔ 网关 HTTP 契约（v1）

想自己实现后端（比如直接接 RVC WebUI、接商业 API、接你家里的另一台机器），只需要满足这份契约。
插件侧的所有请求都会带 `Authorization: Bearer <token>`（除非网关令牌留空）。

- 基础地址：插件设置里的「网关地址」，例如 `https://sing.example.com`（**必须 https**，不带结尾斜杠）
- 编码：`application/json; charset=utf-8`
- 错误约定：非 2xx 一律返回 `{ "ok": false, "message": "给人看的一句话" }`

## GET /health

**免鉴权**（方便排查隧道通不通），只暴露"在不在、什么引擎"：

```json
{ "ok": true, "version": "0.1.0", "engine": "command", "voices": ["me"],
  "source": "itunes", "transcode": "auto", "jobs": 0 }
```

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

## 为什么要异步

宿主给插件工具的超时默认 3 分钟（本插件 `sing_song` 声明 180 秒）。一整首 RVC 换声在 3080 上
通常 20-60 秒，CPU 上可能好几分钟 —— 同步接口会让调用方卡在超时上，还看不到进度。
所以：**提交拿 jobId → 每 1-2 秒问一次 → 完成再下载**。插件在轮询到 `180s - 20s` 时会主动放弃并
回一句"歌太长或电脑在忙"，而不是让宿主硬杀进程。
