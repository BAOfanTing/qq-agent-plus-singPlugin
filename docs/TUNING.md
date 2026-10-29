# 调优与踩坑笔记

这份文件放"为什么这么设、当初踩过什么"，README 只留结论。
如果你只是想让它跑起来，看 [README](../README.md) 和 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 就够了。

---

## 一、唱歌时长：四道闸

一条语音条能唱多久，取决于**四道闸里最小的那个**。改时长只改一道没用，这是最容易踩的坑。

| # | 闸 | 代码位置 | 默认 |
|---|---|---|---|
| ① | 插件设置「语音条唱多久」 | 插件设置页 → `voiceSeconds` → 通过 `POST /admin/voice-seconds` 推给网关 | 90 |
| ② | 语音条通道硬上限 | `gateway/lib/app.mjs`：`cap = config.voiceMessageMaxSeconds` | 300 |
| ③ | 单次任务上限（语音条和群文件**都**受它管） | `gateway/lib/app.mjs`：`runSingJob` 里 `Math.min(config.maxSeconds, …)` | 300 |
| ④ | 宿主 TTS 请求超时 | `tts.timeoutMs`（宿主 config.json） | 600000 |

生效值链路：

```
插件设置 → /admin/voice-seconds → runtimeVoiceSeconds
        → wanted = body.maxSeconds || runtimeVoiceSeconds || voiceMessageDefaultSeconds
        → maxSeconds = min(cap=②, wanted)
        → job.maxSeconds = min(③, maxSeconds)          ← ③ 常常是最后拍板的那个
        → run.py --max-seconds <job.maxSeconds>
```

### 怎么确认现在到底是多少

```bash
curl -s http://127.0.0.1:8899/health | python -m json.tool
```

```json
{ "voiceSeconds": 240, "voiceMaxSeconds": 300, "jobMaxSeconds": 300 }
```

- `voiceSeconds` —— 当前生效值
- `voiceMaxSeconds` —— ② 的取值（插件推大了会被它夹住）
- `jobMaxSeconds` —— ③ 的取值（**最常见的元凶**）

### 实测耗时（RTX 3080 10G / Windows，Hanser 模型）

| 成品长度 | 端到端 | 说明 |
|---|---|---|
| 45 秒 | 20-25 秒 | 最稳 |
| 90 秒 | 25-30 秒 | 默认，群里体验最好 |
| 180 秒 | 4 分钟以上 | 分离 + 换声都按整段算，接近线性 |
| 240 秒 | 4-5 分钟 | 宿主超时 10 分钟够用，但群里要等很久 |

时间主要花在：人声分离（BS-Roformer，RTF≈0.1）+ RVC 换声（含音高提取与索引检索）+ 两次模型加载。

### 另外两条物理限制

- 宿主对 `/v1/audio/speech` 的响应上限 **4MB**（96kbps 单声道 ≈ 5.7 分钟），超了宿主直接报"结果过大"。
- QQ 语音条自身的时长上限：各协议端不同，被拒时机器人会退回文字。以你自己实测为准。

---

## 二、显存

换声是全 GPU 的活。3080 10G 上实测峰值约 9.4G（分离与换声是先后两个子进程，峰值取大的那个）。

为了不把卡占满，`sing-model/run.py` 默认给两个重活子进程都上了闸：

```
--gpu-fraction 0.85            # 默认，最多用 85%（≈8.7G）
```

实现方式：`sing-model/gpu_cap/sitecustomize.py` 被塞进子进程的 `PYTHONPATH`，Python 启动时会自动
import 它并调用 `torch.cuda.set_per_process_memory_fraction(0.85, 0)` —— **不需要改 RVC 任何代码**。
同时设了 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` 来压碎片。

- 想更低：`--gpu-fraction 0.75`
- 阈值太低会 OOM，任务会如实失败（不会假装成功）；调不上去就退回默认
- 想彻底不用显卡：`voice.engine=none`（但那就不叫换声了，只是搬运音源）

---

## 三、历史踩坑（现象 → 根因 → 修法）

这些都已经修好了，列在这避免以后重新踩。

| 现象 | 根因 | 修法 |
|---|---|---|
| 点歌永远只出 30.02 秒 | 当年接过 Apple 的 30 秒试听段当兜底；网易云 VIP 曲取不到音频时立刻退回试听 | **直接删掉试听源**，只留网易云 + 本地目录；VIP 曲现在明确报"需要 VIP"并引导扫码登录 |
| 插件里填 240，实际只唱 180 | ③ `config.maxSeconds` 是 180，`runSingJob` 用 `Math.min` 把它夹回去了 | ③ 提到 300；`/health` 报出 `jobMaxSeconds` 便于核对 |
| 显存闸"加了但没效果" | 只写了 `sitecustomize.py` 和常量，`--gpu-fraction` 参数没定义、`run()` 也没传 → 等于没接线 | CLI 参数 + 传参补齐（分离、换声两处都传） |
| 180 秒的歌跑了一半报"等太久" | 截止时间写成 `min(maxSeconds, cap) + 150000`，把"秒"直接加到"毫秒"上，实际只等了 150 秒 | 改成 `秒 × 1000 + 300000`（留 5 分钟余量） |
| 网关进程莫名退出 | `/login/*` 写在全局 try 之外，网易云接口一抖动就是未捕获的 Promise 拒绝 | 单独 try/catch，返回 502 而不是崩进程 |
| 控制台「扫码登录」报"令牌不对" | 登录接口只认 `?token=` 和 `x-gateway-token`，插件走的是 `Authorization: Bearer` | 三种来源都认 |
| 插件 import 二维码库报 `does not provide an export named 'default'` | 仓库 `package.json` 是 `type=module`，UMD 的 `.js` 被当 ESM 解析 | 改名 `qrcode.cjs` + `createRequire` |
| 机器人说"才一秒"，但语音条显示 1'30" | 宿主按 `Math.round(text.length / 4)` 估时长，「唱：夜曲」4 个字 → 1 秒 | 网关回 `x-audio-seconds` 真实时长，宿主优先用它（宿主侧改动见 `qq-agent-plus` 仓库 `feat/tts-audio-seconds` 分支） |
| `fetch failed`（约 50% 概率） | 服务器只有 IPv6 无出口 + Node Happy Eyeballs 默认 250ms 尝试超时 | 宿主 `NODE_OPTIONS=--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=5000`（实测 12/12 通过） |
| Cloudflare 隧道隔几小时就 530 | 快速隧道是匿名隧道，Cloudflare 明说无可用性保证；建隧接口也会超时 | 备用专线：`ssh -R` + nginx TLS（8898），地址永不变；语音条通道直接走 `https://127.0.0.1:8898/v1` |
| 服务器访问自己的公网 IP:8898 超时 | 华为云安全组/NAT 不回环，`curl https://<公网IP>:8898` 从服务器自己发出会 000 | 宿主侧改用 `https://127.0.0.1:8898/v1`；插件侧禁用内网地址，只能走公网隧道 |
| `upload_group_file ENOENT` | OneBot 跑在容器里，看不到宿主的插件媒体目录 | `scripts/bridge-container-paths.sh`（宿主建软链 + 容器内 `ln -sfn /app/data /opt/qq-agent/data`） |
| `unable to get local issuer certificate` | CA 被重建过，但服务器证书还是旧 CA 签的 | 重新签：`bash reissue-server-cert.sh <IP>`；宿主 `NODE_EXTRA_CA_CERTS=/opt/qq-agent/tls/ca.crt` |

---

## 四、改完配置后的验收清单

改时长/显存/通道后，按这个顺序确认，比在群里盲试快得多：

1. 网关自检：`curl -s http://127.0.0.1:8899/health` → `ok:true`，三个秒数符合预期
2. 隧道自检：`bash scripts/check-lines.sh`（需要先 scp 到服务器）→ 隧道口 200、8898 200
3. 真链路：宿主控制台的 TTS「试听」按钮，输入 `唱：歌名` → 能听到声音就说明全链路通
4. 群里实测：`用语音唱一首X` → 看语音条时长、机器人报的秒数、有没有声音
5. 出问题先看网关日志：每个请求一行 `[req] · POST /v1/audio/speech → 200 (24207ms)`；
   有这行说明请求到了并成功，没有这行说明是传输问题（隧道/超时/鉴权）
