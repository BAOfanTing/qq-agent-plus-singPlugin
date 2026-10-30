<p align="center">
  <img src="assets/icon.png" width="120" height="120" alt="qq-agent-plus-SingPlugin">
</p>

<h1 align="center">qq-agent-plus-SingPlugin</h1>

<p align="center"><em>点歌 · 换声 · 发语音条 —— 给 qq-agent-plus 的唱歌插件</em></p>

给 [qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus) 的**点歌唱歌**插件：
群里说「用语音唱一首 X」，机器人用你自己训练的音色翻唱，直接发 QQ 语音条。

> ⚠️ **前提**：换声模型（RVC）和网关都跑在**你自己的电脑**上（本仓库的 `gateway/` 与 `sing-model/`）。
> 服务器只做转发、不装模型；电脑没开时机器人只会提示「后端离线」。

![image-20261029231050894](https://gitee.com/baofanting/image/raw/master/image/20261029231050950.png)

## 它怎么工作

```
QQ 群 ──► 宿主(服务器) ──► 插件 sing ─────────────┐
                                                  ▼
                                   你的电脑：网关 :8899 → 搜歌 → 人声分离 → RVC 换声 → 混音
                                                  │   （全程本地，音频不上传）
        宿主 send_voice ◄── /v1/audio/speech ◄────┘
```

| 通道 | 触发方式 | 产出 | 备注 |
|---|---|---|---|
| **语音条**（默认） | 「用语音唱一首 X」 | QQ 语音气泡 | 走宿主自带 `send_voice` |
| **群文件** | 「点歌唱一首 X」 | mp3 文件 | 需先在插件设置里打开「允许发群文件」 |

插件本身没有发语音条的能力（宿主只给插件 `send.text` / `send.file`），所以语音条只能借宿主的 TTS 通道。

## 快速开始

五步，详细命令在 **[docs/INSTALL.md](docs/INSTALL.md)**：

1. **电脑端**：Python 3.12 环境 + RVC 资产（hubert/rmvpe/分离模型）+ 你的 `.pth` 音色 — [1](docs/INSTALL.md)
2. **电脑端**：`gateway/config.json` 填令牌、音色、换声命令 — [2](docs/INSTALL.md)
3. **电脑端**：起网关 `start-gateway.bat`，起隧道 `start-tunnel.bat` — [3](docs/INSTALL.md)
4. **服务器端**：`plugin/sing` 放进 `data/plugins/`，控制台启用并填网关地址 + 令牌 — [4](docs/INSTALL.md)
5. **语音条通道**：宿主 TTS 指向 `<网关地址>/v1` — [5](docs/INSTALL.md)

跑通后群里直接用：

```
用语音唱一首夜曲      # 语音条（默认只走这条）
点歌唱一首夜曲        # 群文件（要先打开「允许发群文件」）
网易云怎么登录        # 想唱 VIP 曲原唱：控制台插件页点「扫码登录」扫一下
```

## 实测数据

RTX 3080 10G / Windows / v1.0.0：

| 环节 | 耗时 |
|---|---|
| 网易云搜歌 | < 1 秒 |
| 人声分离（BS-Roformer 368） | 30 秒歌约 3-6 秒（RTF 0.10） |
| RVC 换声（hanser，30 秒片段） | 约 4 秒（另加 6-8 秒模型加载） |
| **端到端（点歌 → 群里收到）** | **20-25 秒**（45 秒成品）/ 25-30 秒（90 秒成品） |
| GPU 显存峰值 | 约 9.4 GB（默认用 `--gpu-fraction 0.85` 上闸） |

首次点歌总是慢十几秒——每次都要重新加载模型，属正常。

## 插件设置

控制台 → 插件 → 点歌唱歌：

| 设置 | 默认 | 说明 |
|---|---|---|
| 网关地址 `gatewayUrl` | — | 网关的公网 https 地址 |
| 备用网关地址 `gatewayUrlFallback` | 空 | 主地址连不上时自动切换（记住 2 分钟） |
| 网关令牌 `apiToken` | — | 与网关 `config.json` 的 `token` 一致（加密保存） |
| 默认音色 `defaultVoice` | 空 | 网关配置里的音色名；空=用网关默认 |
| 允许发群文件 `allowFileOutput` | **关** | 关着只用语音条；开启后模型才可能用群文件发 mp3 |
| 语音条唱多久 `voiceSeconds` | 90 | 秒；改完自动推给网关。上限见 [TUNING](docs/TUNING.md) |
| 群文件唱多久 `maxSeconds` | 60 | 秒（上限 180）；仅「允许发群文件」打开时生效 |

网关侧配置（`gateway/config.json`）见 [docs/INSTALL.md](docs/INSTALL.md) 与 [docs/TUNING.md](docs/TUNING.md)。

## 已知限制

1. **只唱歌，不做 TTS**：普通说话会失败，宿主会退回文字，不丢消息。
2. **一次只跑一个任务**：换声吃显存，网关串行排队（故意的）。
3. **首次点歌慢**：每次重新加载模型，10 秒上下。
4. **VIP 曲需要登录**：没登录态取不到原唱时会先找同曲可播版本，都不行就明确提示扫码登录。
5. **版权自负**：`.pth` 权重与翻唱成品的使用范围请自行确认。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 完整安装：环境、RVC 资产、网关、隧道、服务器、容器桥接、开机自启、截图清单 |
| [docs/TUNNEL.md](docs/TUNNEL.md) | 把本机网关暴露成 https：Cloudflare 快速隧道 / 备用专线（ssh -R + nginx TLS） |
| [docs/TUNING.md](docs/TUNING.md) | 时长四道闸、显存上限、历史踩坑、改完配置的验收清单 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 运行期报错：发文件 ENOENT、只有原声没换声、超时、fetch failed |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | 插件 ↔ 网关 HTTP 契约（想用别的语言重写后端看这个） |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地跑测试、代码结构 |

## License

MIT。模型、音源、音色的许可与版权请自行确认。
