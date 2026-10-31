# 说话（TTS）

宿主的 `send_voice` 指向本网关后，机器人**所有**语音请求都会打到 `/v1/audio/speech`：

| 输入 | 走什么 | 耗时（实测） |
|---|---|---|
| 含点歌意图（`唱：歌名`、`点歌唱…`、句中触发） | 换声唱歌（本机 GPU，整首自动分段） | 12 秒（45 秒成品）/ 22 秒（整首 3:54） |
| 其它文本 | **说话**：Breeze TTS 2 云端（`api.breeze.blue`） | **3-6 秒** |

唱歌那条路见 [TUNING.md](TUNING.md)。这里只讲"说话"。

## 为什么是 Breeze

| 方案 | 音质 | 占显存 | 成本 | 适合 |
|---|---|---|---|---|
| **Breeze TTS 2 云端** | 开源权重里最好（官方 #1），50 个音色 | **0** | 按字符计费 | 日常、要快、不想下权重 |
| **Breeze 本地权重** | 同上 | 8.2 G（**说话时才加载，闲置 1 分钟自动退出**） | 免费 | 不想花额度、要离线、要自定义音色 |

云端不占显卡，唱歌和说话互不干扰；本地靠"闲置退出"把显存还回去，所以也不用担心一直占着。

> 早期试过 Windows SAPI（机械、没法听）和 Edge TTS（要另装一套 Python 环境、音色固定），都已移除。

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


## 本地部署（`say.engine: "breeze-local"`）

不想花额度、或想离线跑，就把权重放本机。**代价是 7.7 GB 显存**（eager），
所以和唱歌的 RVC 常驻（~2 GB）**不能同时用**——好在网关会在本地失败时自动退回云端。

### 1. 准备权重

从 Hugging Face `BreezeBlue/breeze-tts-2` 下到 `say-model\weights\breeze-tts-2\`，**必须包含**：

```
config.json  generation_config.json  model.safetensors.index.json
model-00001-of-00002.safetensors  model-00002-of-00002.safetensors
tokenizer.json  tokenizer_config.json  special_tokens_map.json
audio_tokenizer\            ← 整个目录（缺它 load_runtime 直接报错）
   config.json  configuration.json  preprocessor_config.json  model.safetensors
```

合计约 **7.8 GB**。下完先体检：

```powershell
E:\APP\Anaconda\envs\sing\python.exe say-model\check-ckpt.py
```

全 ✓ 才算完整（`.crdownload` 半截文件会被点名）。

### 1.5 依赖（一次性）

本地说话要 GPU 侧依赖，且 **`triton` 不是可选项**——Breeze 的 `fast_streaming` 在 import
期就 `import triton`，缺了直接启动失败。完整清单与坑见 **[ENV.md](ENV.md)**，最短路径：

```powershell
python -m pip install torch==2.9.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cu128
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 2. 启动本地服务

```powershell
powershell -ExecutionPolicy Bypass -File say-model\start-local.ps1
# 装好 MSVC Build Tools + CUDA 12 之后可以加 -Fast（编译 CUDA graph，快约 3 倍）
```

- 默认 `http://127.0.0.1:7860`，进程与日志在 `say-model\logs\`
- 第一次要读 7 GB 权重进显存，1-3 分钟；`/health` 返回 `{"status":"loading"}` 时就还没好
- eager 模式**不需要** MSVC / CUDA toolkit（`--fast-*` 才要）

### 3. 切到本地

`gateway/config.json`：

```json
"say": {
  "engine": "breeze-local",
  "localUrl": "http://127.0.0.1:7860",
  "refAudio": "<参考音频路径>",   // 参考音频（克隆用；留空 = 纯语气设计）
  "refText": "参考音频里说的那段话的准确文字稿",
  "instructions": "语气亲切一点，语速稍慢",
  "cfgScale": 4.0,
  "localTimeoutMs": 180000
}
```

- 有 `refAudio` + `refText` → **克隆**那个音色（3-10 秒干净人声，无伴奏最好）
- 只有 `instructions` → **Voice Design**（纯文字描述造音色）
- 本地挂了且配了 `breezeKey` → 自动退回云端，日志里会写 `[say] 本地 Breeze 失败，退回云端`

### 3.5 让网关托管（推荐，按需加载 + 闲置退出）

本地模型不会一直占着显卡：**说话时才加载，闲置 `say.localIdleMs`（默认 60 秒）后自动退出**，
把 8.2 GB 显存还回去。实测：说完一句话，70 秒后显存从 8.3 GB 掉回 1.6 GB。

代价是"闲置后第一句"要重新加载（约 8 秒加载 + 首次请求预热，实测 36 秒/句），
紧接着的第二句回到 12-16 秒。想常驻不退就把 `say.localIdleMs` 设成 `0`。

### 3.5 让网关托管（推荐）

不用自己开终端起 python —— 配好这两项，**网关会在需要时自己拉起/关掉**本地模型：

```json
"say": {
  "localPython": "<装了 torch 的 python>",
  "localModelDir": "<仓库路径>/say-model/weights/breeze-tts-2",
  "localAppDir": "<仓库路径>/say-model",
  "localIdleMs": 60000          // 闲置多久退出（毫秒）；0 = 常驻不退
}
```

`start-local.ps1` 只在你想手动调试时用；网关自己起的那份会把日志写到网关 stdout。

### 4. 和云端对比

| | 云端 | 本地（eager，实测） |
|---|---|---|
| 显存 | 0 | **7.9 GB** |
| 成本 | 0.186 额度/字符 | 0 |
| 首句 | 3-6 秒 | 首次 39 秒（含 8 秒加载 + 编译预热） |
| 稳态每句 | 3-6 秒 | **7-9 秒**（2-5 秒音频，RTF≈2-3） |
| 音色 | 50 个预置 | 任意参考音频 / 任意文字描述 |
| 许可 | 免费版禁商用 | 权重仅研究/非商用 |

> 想更快就装 MSVC Build Tools + CUDA 12 toolkit，然后用 `start-local.ps1 -Fast`（CUDA graph，约快 3 倍）。

### 和唱歌抢显存时怎么办（自动让位）

本地 TTS 常驻 7.9 GB，RVC 换声也要几个 GB —— 10 GB 卡上挤在一起，实测唱歌从 **10 秒变 51 秒**
（显存颠簸）。所以网关内置了让位调度（`say.localPython` / `say.localModelDir` 配好就生效）：

| 时刻 | 动作 |
|---|---|
| 收到唱歌任务 | 先 `taskkill` 本地 TTS 进程，显存还给换声 |
| 收到说话请求 | 先收掉换声常驻（闲着也占 2.4 GB），再拉起本地 TTS 并等 `/health` 通 |
| 显存不够 / 本地没起来 | 自动退回云端（配了 `breezeKey` 才生效） |

**代价（务必知道）**：每次切换都要重新读权重 + 预热，实测**约 30-40 秒**。
宿主真链路实测：说话 32 秒（含加载）→ 唱歌 41 秒（RVC 也是冷启动）→ 说话 40 秒（又要重载本地）。

所以：
- **经常又唱又说** → 说话用云端（0 显存，唱歌保持 22 秒，无切换开销）
- **只想省钱、能忍延迟** → 本地；把 `say.engine` 设成 `breeze-local`，切换开销就当它是"冷启动"
- 本地常驻期间（不切换）稳态是 **7-9 秒/句**

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `说话后端离线：API Key 不对` | `xi-api-key` 的值要完整（带 `brz_` 前缀）；确认 Key 没被禁用/撤销 |
| 机器人还是发文字 | 插件设置里 Key/音色填了没；再看网关日志里有没有 `[say] N 字 → M 秒` |
| `Breeze 返回 402/429` | 额度不足或撞频率限制 → 查 `/v1/balance` |
| 宿主报 `HTTP 524` | 语音条通道走了 Cloudflare 快速隧道（约 100 秒限制）→ 改本机 8898 专线，见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| `ModuleNotFoundError: No module named 'triton'` | 本地说话缺 triton-windows，见 [ENV.md](ENV.md) |
| 本地返回 500 `does not define a negative prompt but cfg_scale=4.0` | 参考克隆模式不支持 CFG，网关已自动压到 1；手调时别给 cfg>1 |
| 机器人唱不了歌 | 那是唱歌链路，看 [TUNING.md](TUNING.md) |

`/health` 里能看到当前引擎：`"say": "breeze"`。
