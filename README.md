# QQ Agent 点歌唱歌 · SingPlugin

给 [qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus) 加一句话能力：**点一首歌，机器人用你的音色翻唱，发到群里。**

```
QQ 群里：「用语音唱一首起风了」
        │
        ▼
  QQ Agent（你的服务器，2 核 2G 也行）              你的电脑（有显卡那台）
  ┌──────────────────────────────┐         ┌────────────────────────────────┐
  │ 插件 sing（薄客户端）          │  https  │ gateway（本仓库 gateway/）       │
  │  · 只做转发、发文件/发语音条    │ ──────► │  搜歌 → 人声分离 → RVC 换声 → 混音 │
  │  · 不装 torch、不建模型        │  隧道   │  Python 3.12 + torch cu128       │
  └──────────────────────────────┘         └────────────────────────────────┘
```

一句话分工：**服务器只管转发，重活全在你自己的电脑上。**

- 插件可独立装卸，**不改 qq-agent 一行核心代码**；
- 你电脑关机 = 点歌失败（模型会说明后端离线），**文字聊天不受影响**；
- 服务器不用装任何模型。

---

## 30 秒上手（已经部署好的人看这里）

```bash
# 电脑：起网关（守护版，崩了自动重启）
powershell -ExecutionPolicy Bypass -File scripts/run-gateway-forever.ps1
# 电脑：起隧道（快速隧道每次重启域名会变）
start-tunnel.bat
```

群里说 **「用语音唱一首雨爱」**（语音条）或 **「点歌唱一首雨爱」**（mp3 文件）。

| 出问题了 | 看这里 |
|---|---|
| 只出 30 秒 | 那首歌网易云只有试听段 → 打开 `<网关地址>/login` 扫码登录（VIP 后可取原唱） |
| `fetch failed` | 网关没起 / 隧道断了 / 服务器没 IPv6 → `docs/TROUBLESHOOTING.md` 里"fetch failed 四步" |
| 收到的是群文件不是语音条 | 模型选了插件通道 → 说"用语音"，或按第七节把它停掉 |
| `upload_group_file ENOENT` | 容器看不到插件媒体目录 → `scripts/bridge-container-paths.sh` |

---

## 一、它能干什么

| 通道 | 触发方式 | 产出 | 上限 |
|---|---|---|---|
| **语音条**（推荐） | 「用语音唱一首 XXX」 | QQ 语音气泡，点开就播 | 受 QQ 语音条时长限制，见 config `voiceMessageMaxSeconds`（默认 120 秒） |
| **群文件** | 「点歌唱一首 XXX」 | mp3 文件，可下载收藏 | 150 秒 |

两条通道都走同一个网关、同一套换声；区别只在「谁来发」：

- 语音条 = 宿主自带的 `send_voice` 工具（`POST /v1/audio/speech` → record 段）；
- 群文件 = 本插件（`cap.media.download` → `cap.send.file`）。

> 插件没有发语音条的能力（宿主只给插件 `send.text` / `send.file`），所以语音条只能借宿主自己的 TTS 通道 —— 详见[第 3.3 节](#33-语音条通道把宿主-tts-指向网关)。

## 二、实测数据（RTX 3080 10G / Windows）

| 环节 | 耗时 |
|---|---|
| 网易云搜歌 | < 1 秒 |
| 人声分离（BS-Roformer 368） | 30 秒歌约 3-6 秒（RTF 0.10） |
| RVC 换声（hanser 音色，30 秒片段） | 约 4 秒（另加 6-8 秒模型加载） |
| **端到端（点歌 → 群里收到）** | **20-25 秒**（45 秒成品）/ 31 秒（120 秒成品） |
| GPU 显存占用 | 约 9.4 GB 峰值 |

模型加载每次都要重来（插件按需起进程），所以**第一次点歌总是慢十几秒**，属正常。

## 三、目录

```
plugin/sing/          qq-agent 插件本体（零依赖，可打包上架）
  plugin.json         manifest（apiVersion 2；能力 tools/schedule/log/config/secrets/http/media/send）
  index.mjs           协议接线 + 三个工具 + 每小时一次的零点清理触发
  lib.mjs             纯函数（地址校验、设置收敛、文件名白名单、任务状态机）
gateway/              跑在你电脑上的换声网关（零依赖 Node）
  server.mjs          入口；含每天 00:00 的成品清理排程
  lib/config.mjs      配置读写与校验
  lib/sources.mjs     音源：网易云 / iTunes / 本地目录（含搜索排序打分）
  lib/voice.mjs       换声：none（直出）/ command（调你的 RVC 命令行）
  lib/app.mjs         路由 + 流水线（/health /search /sing /jobs /files /v1/audio/speech /admin/prune /login*）
  web/login.html      网易云扫码登录页（二维码在本地渲染，key 不出本机）
  web/qrcode.js       内置 QR 生成库（MIT，离线可用，不依赖任何 CDN）
  lib/jobs.mjs        串行任务队列（带进度与 TTL）
sing-model/
  run.py              换声编排：裁剪 → 分离 → 换声 → 混伴奏（网关调的就是它）
  fetch-*.ps1         拉模型的脚本（分块/续传，国内镜像会断流）
  rvc/                新版 RVC 源码 + 权重（.gitignore 排除，不进仓库）
docs/PROTOCOL.md      插件 ↔ 网关 HTTP 契约（想用别的语言重写后端看这个）
docs/TUNNEL.md        把本机网关暴露成 https 的三种做法
docs/TROUBLESHOOTING.md  排错（含容器化 OneBot 发文件失败那个坑）
scripts/bridge-container-paths.sh  把插件媒体目录桥接进 OneBot 容器
start-gateway.bat / start-tunnel.bat  Windows 一键启动
test/                 32 个用例（含"子进程跑插件、测试扮演宿主"的真协议测试）
```

---

## 四、部署

### 总览：四件事

1. 电脑上装 RVC 环境 + 网关 → 本机 `127.0.0.1:8899` 能点歌；
2. 把网关暴露成 **https**（宿主强制禁内网，`127.0.0.1` 填不进去）；
3. 服务器上装插件、填设置；
4. （要发群文件的话）把插件媒体目录**桥接进 OneBot 容器**。

### 4.1 电脑端：Python 环境（RVC）

RVC 新版**已经不需要 fairseq**（hubert 走 transformers），所以不用编译、不用一键包，一条 pip 装完。
要求 **Python 3.12 + torch 2.7.1+cu128**（torch 必须 < 2.8）。

```bash
# 1) 建环境（conda 或 venv 都行）
conda create -y -n rvc python=3.12

# 2) CUDA 版 torch（3.1GB；国内建议用南京大学镜像）
conda run -n rvc python -m pip install \
  --index-url https://mirrors.nju.edu.cn/pytorch/whl/cu128 \
  --extra-index-url https://mirrors.pku.edu.cn/pypi/simple \
  "torch==2.7.1+cu128" "torchaudio==2.7.1+cu128"

# 3) 项目依赖（RVC 自带的清单）
cd sing-model/rvc
conda run -n rvc python -m pip install -r requirments_cu128_py312.txt

# 4) 验证 CUDA
conda run -n rvc python -c "import torch;print(torch.__version__, torch.cuda.is_available())"
# → 2.7.1+cu128 True

# 5) ffmpeg（RVC 解码与混音都要用；imageio 自带二进制，不用装系统 ffmpeg）
conda run -n rvc python -m pip install imageio-ffmpeg
python -c "import imageio_ffmpeg,shutil,os;os.makedirs('bin',exist_ok=True);shutil.copyfile(imageio_ffmpeg.get_ffmpeg_exe(),'bin/ffmpeg.exe')"
```

### 4.2 电脑端：RVC 资产

放这些文件（路径写死在 RVC 里，别改结构）：

```
sing-model/rvc/assets/
├── hubert_base/            config.json / preprocessor_config.json / pytorch_model.bin
├── rmvpe/rmvpe.pt
├── pymss_weights/          人声分离模型（model_bs_roformer_ep_368_sdr_12.9628.ckpt）
├── weights/                你的音色 .pth（可分子目录）
└── indices/                对应的 .index
```

```bash
# hubert_base 与 rmvpe 来自 lj1995/VoiceConversionWebUI（国内可用 hf-mirror）
# 分离模型用 pymss 的下载器（走 ModelScope，很快）
conda run -n rvc python -m pymss.cli download model_bs_roformer_ep_368_sdr_12.9628.ckpt \
  --model-dir rvc/assets/pymss_weights --source modelscope
# 下载后可能在 vocal/vocal_extraction/ 子目录里，把 .ckpt 和 .yaml 复制到 pymss_weights/ 根目录
```

大文件下不动时（国内镜像会断流），用仓库里的 `fetch-chunks.ps1`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File sing-model/fetch-chunks.ps1 `
  -Url "https://mirrors.nju.edu.cn/pytorch/whl/cu128/torch-2.7.1%2Bcu128-cp312-cp312-win_amd64.whl" `
  -Out "sing-model/downloads/torch-2.7.1+cu128-cp312-cp312-win_amd64.whl"
# 下完核对官方 sha256（PyTorch 索引页里有），不一致就重下
```

### 4.3 电脑端：放音色权重

```
sing-model/rvc/assets/weights/<音色名>.pth        ← 例如 hanser.pth、zhoushuyi/zhoujie.pth
sing-model/rvc/assets/indices/<音色名>.index      ← 有就放，相似度会明显提升
```

`run.py` 支持三种指法：文件名（`hanser`）、相对路径（`布洛尼亚/hanser`）、包含匹配（`hans`）。

```bash
# 单测一句，确认权重能被加载
conda run -n rvc python sing-model/run.py --input 任意音频.mp3 --output out.wav --voice hanser --max-seconds 20
```

> ⚠️ 权重是**第三方角色模型**，用于他人都涉及肖像与授权问题；自己本地玩没问题，别把 `.pth` 提交到仓库（`.gitignore` 已排除）。

### 4.4 电脑端：网关配置

```bash
cd gateway
cp config.example.json config.json
# 把 token 改成一串随机字符（openssl rand -hex 24 / 网页随机串都行）
```

| 键 | 说明 |
|---|---|
| `token` | **必设**。插件与宿主都带 `Authorization: Bearer <token>` |
| `source.type` | `netease`（默认，中文曲库全）/ `itunes`（30 秒试听段）/ `local`（你自己的音频目录） |
| `source.neteaseCookie` | 网易云登录后的 `MUSIC_U=…`。**VIP 曲不填拿不到原唱**；不填会自动降级到同名免费翻唱版 |
| `source.localDir` | `local` 时必填 |
| `voice.engine` | `command`（真换声，用你的 RVC）/ `none`（直出原音，只用来验证链路） |
| `voice.command` | 换声命令，占位符 `{input}` `{output}` `{voice}` `{pitch}` `{maxSeconds}`；另有环境变量 `SING_INPUT` 等 |
| `voice.outputExt` | 换声产物格式（默认 `wav`） |
| `voice.defaultVoice` | 默认音色名（例如 `hanser`） |
| `outputArtist` | 群里显示的「演唱者」名字，默认 **小鲸鱼**（原唱信息只留在"原唱受限"说明里） |
| `transcode` | `auto`（有 ffmpeg 就转 mp3 并裁剪）/ `never` |
| `maxSeconds` | 群文件通道最长时间（默认 150 秒） |
| `voiceMessageMaxSeconds` | 语音条通道最长时间上限（默认 120 秒，按实测调） |
| `voiceMessageDefaultSeconds` | 语音条默认唱多久（默认 90 秒，受上面那个夹紧）。宿主调 `/audio/speech` 时不带时长，就用它 |
| `filesTtlHours` | 成品保留小时数（默认 24，另有每天 0 点清理） |

本机这套的实际配置（供对照）：

```json
{
  "port": 8899, "host": "127.0.0.1", "token": "<随机串>",
  "source": { "type": "netease", "localDir": "", "neteaseCookie": "", "limit": 5 },
  "voice": {
    "engine": "command",
    "command": "\"<conda路径>/envs/rvc/python.exe\" \"<仓库路径>/sing-model/run.py\" --input {input} --output {output} --voice {voice} --pitch {pitch} --max-seconds {maxSeconds}",
    "timeoutMs": 900000, "pitch": 0, "outputExt": "wav", "defaultVoice": "hanser"
  },
  "transcode": "auto", "maxSeconds": 150, "voiceMessageMaxSeconds": 120,
  "filesTtlHours": 24, "outputArtist": "小鲸鱼", "dataDir": "gateway-run"
}
```

### 4.5 电脑端：启动

```powershell
# 方式一：双击
start-gateway.bat

# 方式二：命令行（建议把 ffmpeg 与 conda 的 Scripts 放进 PATH）
node gateway/server.mjs
```

启动日志会打印音源、换声引擎、鉴权状态和**下次零点清理时间**。自检：

```bash
curl -s http://127.0.0.1:8899/health
# {"ok":true,"engine":"command","voiceConfigured":true,"voices":["hanser"],...}
```

### 4.6 暴露成 https（必须）

宿主给插件的联网能力写死 `allowPrivate:false`，`127.0.0.1`、`192.168.x.x` 一律拒绝。最省事：

```powershell
start-tunnel.bat
# 或手动：
cloudflared tunnel --url http://127.0.0.1:8899 --no-autoupdate
# 输出里形如 https://xxxx-yyyy.trycloudflare.com ← 这就是"网关地址"
```

**快速隧道的域名每次重启都变**，变了要去插件设置里改一次。要固定就用 named tunnel / frp，
见 [docs/TUNNEL.md](docs/TUNNEL.md)。

### 4.7 服务器端：装插件

```bash
# 打包（ustar，宿主安装器认这个格式）
tar --format=ustar -czf /tmp/sing-0.1.0.tar.gz -C plugin sing

# 拷到服务器后解压到数据目录（插件目录独立于宿主源码，升级宿主不会被覆盖）
ssh <user>@<host>
sudo su -          # 插件目录属主是 qqagent
cd /opt/qq-agent/data && mkdir -p plugins
tar xzf /tmp/sing-0.1.0.tar.gz -C plugins
chown -R qqagent:qqagent plugins/sing
```

然后在控制台「插件」页刷新/重载，就能看到「点歌唱歌」。

### 4.8 服务器端：填设置

控制台 → 插件 → 点歌唱歌 → 设置：

| 字段 | 填什么 |
|---|---|
| 网关地址 | 隧道给的 `https://…`（不要带结尾斜杠） |
| 网关令牌 | 与 `gateway/config.json` 的 `token` 一致 |
| 默认音色 | 例如 `hanser` |
| 最长演唱秒数 | 群文件通道用的秒数（语音条通道另有上限） |
| 任务轮询间隔 / 允许 http 网关 | 保持默认即可（后者仅调试用） |

也可以用控制台 API 批量写（脚本里就是这么做的）：

```bash
curl -X POST http://127.0.0.1:3210/api/plugins/settings \
  -H "x-console-token: $TOKEN" -H 'Host: 127.0.0.1:3210' -H 'content-type: application/json' \
  -d '{"id":"sing","values":{"gatewayUrl":"https://xxx.trycloudflare.com","apiToken":"<网关令牌>","defaultVoice":"hanser","maxSeconds":45}}'
```

最后在插件页**启用**它（`plugins.enabledIds` 里要有 `sing`）。

### 4.9 语音条通道：把宿主 TTS 指向网关

控制台 → 设置 → **语音回复 (TTS)**：

| 字段 | 填什么 |
|---|---|
| 允许机器人发语音 | **打开** |
| 服务预设 | 自定义 / 自建（OpenAI 兼容 `/audio/speech`） |
| 服务地址 | `https://<隧道域名>/v1` |
| 模型 | 任意（网关不校验），建议填音色名 |
| 音色 (voice) | 音色名，例如 `hanser` |
| API Key | 网关令牌 |
| 语速 / 增益 | 1 / 0 |

再加一条配置（界面没有，直接写 config）：**超时调到 180 秒**，否则长歌会在宿主侧先超时。

```bash
curl -X POST http://127.0.0.1:3210/api/config \
  -H "x-console-token: $TOKEN" -H 'Host: 127.0.0.1:3210' -H 'content-type: application/json' \
  -d '{"tts":{"timeoutMs":180000}}'
```

网关对 `/v1/audio/speech` 的处理：认出「唱：歌名」就跑唱歌流水线并返回音频；
**认不出（普通说话）会明确返回 400**，宿主会退回发文字。

### 4.10 服务器端：把媒体目录桥接进 OneBot 容器（发群文件必须）

如果 OneBot（SnowLuma）跑在 Docker 里，宿主的 `cap.send.file` 传的是**宿主绝对路径**，
容器里解析不到 → `upload_group_file retcode=100 ENOENT`。

```bash
sudo bash scripts/bridge-container-paths.sh
# 幂等；不重建容器、不用重新扫码登录
```

它做两件事：宿主 `data/plugin-data` → 挪进容器可见的 `snowluma/data/`（原位置留软链）；
容器内建 `/opt/qq-agent/data -> /app/data`。

> **容器重建后**（`docker rm` / `compose up --force-recreate`）重跑一次即可。

---

## 五、怎么用（群里）

| 你说 | 会发生什么 |
|---|---|
| 用语音唱一首起风了 | 语音条（走宿主 TTS 通道） |
| 点歌唱一首起风了 | 群文件 mp3（走插件） |
| 先搜一下 起风了 有哪些版本 | 只搜不出声，返回 5 条候选 |
| 点歌后端还活着吗 | 查网关在线状态与可用音色 |

输出命名：`歌名 - 小鲸鱼.mp3`（「演唱者」写机器人自己，可用 `outputArtist` 改）。
若原唱受版权限制，网关会自动换成同名免费翻唱版，并在结果里注明「原唱源受限，改用…」。

![image-20261029173828039](https://gitee.com/baofanting/image/raw/master/image/20261029173828141.png)

## 六、运维

| 事项 | 怎么做 |
|---|---|
| **每天 0 点清理** | 网关 `server.mjs` 每天 00:00:05 删掉"今天以前"的成品；插件 `daily_prune`（每小时醒一次）在 0 点拨一次网关 `/admin/prune`。手动触发：`curl -X POST -H "authorization: Bearer <token>" http://127.0.0.1:8899/admin/prune` |
| **服务器侧的媒体文件** | 插件没有删文件的能力（宿主能力表里没有 delete）。宿主自动只保留最近 **12 个**文件 + 每插件 256MB 配额，因此不需要手工清 |
| **网关守护（防崩溃/误关）** | `powershell -ExecutionPolicy Bypass -File scripts/run-gateway-forever.ps1` —— 退出后 3 秒自动重启，日志写 `gateway/gateway-run/gateway.log`。开机自启见下 |
| **隧道换域名** | `bash /opt/qq-agent/set-gateway-url.sh https://新域名` —— 一次改**两处**（插件 gatewayUrl + 宿主 TTS baseUrl）并回读确认 |
| 日志 | 网关每个请求一行 `[req] · POST /v1/audio/speech → 200 (24207ms)`；插件日志：控制台 → 插件 → 点歌唱歌，或 `journalctl --user -u qq-agent-linux \| grep plugin:sing` |
| 更新插件 | 重新打包 → 解压覆盖 `data/plugins/sing` → 控制台重载 |
| 更新网关 | 改 `gateway/` 代码后重启 `node gateway/server.mjs` |
| 暂停/卸载 | 控制台停用插件即可；彻底卸载删掉 `data/plugins/sing`，宿主立即恢复原状（宿主源码一行未被改动） |

## 七、已知限制（诚实版）

1. **语音条时长尚未定论**：60 秒是「手机 QQ 录音」的限制，服务端对 record 段的策略随协议端不同。
   现在上限可配（`voiceMessageMaxSeconds`），请以你自己实测为准，被拒就调小。
2. **普通说话会失败**：网关只做唱歌，不做 TTS。宿主发语音失败会自动退回文字，不会丢消息。
3. **一次只跑一个任务**：换声吃显存，网关串行排队（故意的）。
4. **首次点歌慢**：每次都要重新加载模型（10 秒上下）。
5. **网易云 VIP 曲**：匿名拿不到直链，需填 `neteaseCookie`；否则自动降级翻唱版。
6. **模型与音源版权**：`.pth` 权重、翻唱成品的使用范围请自行确认。

## 八、排错

见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)：发文件 ENOENT、只有原声没换声、点歌超时、
网易云取不到音频，都写在那儿。

## 九、开发与测试

```bash
node --test            # 32 个用例：插件纯函数 / 网关队列 / 网关路由 / 真协议集成
node gateway/server.mjs

# 宿主侧的验证工具（在 qq-agent-plus 仓库里跑）
node scripts/plugin-validate.mjs <本仓库>/plugin/sing
node scripts/plugin-dev.mjs <本仓库>/plugin/sing --call sing_status
```

契约见 [docs/PROTOCOL.md](docs/PROTOCOL.md)；想换后端（Python/Go 都行）只需实现同样的五个接口。



### 开机自启（Windows）

```powershell
schtasks /create /tn "SingGateway" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File E:\path\to\SingPlugin\scripts\run-gateway-forever.ps1" /sc onlogon /rl highest
schtasks /create /tn "SingTunnel"  /tr "E:\Cache\qq-agent\tools\cloudflared.exe tunnel --url http://127.0.0.1:8899 --no-autoupdate" /sc onlogon /rl highest
```

> 隧道用快速模式时，**每次重启域名都会变** —— 变了跑一次 `set-gateway-url.sh`。
> 想彻底省事就换成固定域名（named tunnel），见 [docs/TUNNEL.md](docs/TUNNEL.md)。

### 服务器侧的 IPv6 加固（一次性）

服务器没有 IPv6 出口时，Node 的 fetch 会先试 AAAA，高峰期容易卡成 `fetch failed`：

```bash
mkdir -p ~qqagent/.config/systemd/user/qq-agent-linux.service.d
printf '[Service]\nEnvironment=NODE_OPTIONS=--dns-result-order=ipv4first\n' \
  > ~qqagent/.config/systemd/user/qq-agent-linux.service.d/ipv4first.conf
chown -R qqagent:qqagent ~qqagent/.config/systemd/user
su - qqagent -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user daemon-reload && systemctl --user restart qq-agent-linux'
```

## 十、可选：不经过 Cloudflare 的备用通道（已搭好，一条命令切）

快速隧道（`trycloudflare.com`）是 Cloudflare 明说"无可用性保证"的免费通道，偶发抖动。
如果受够了，可以改走**你自己服务器的反向隧道 + nginx TLS**：

```
你的电脑 ──ssh -R──► <你的服务器IP>:127.0.0.1:8899 ──nginx TLS(8898)──► 宿主
```

优点：不经过第三方、延迟毫秒级、不受 IPv6/Happy Eyeballs 影响。
代价：要先在安全组放行 **8898**，并且宿主进程要信任本机自签 CA。

**启用**

```bash
# 服务器（各一次）
bash install-nginx-tls.sh                 # 生成 CA/证书 + 8898 站点（当前是 .disabled）
mv /etc/nginx/conf.d/sing-gateway.conf.disabled /etc/nginx/conf.d/sing-gateway.conf
nginx -t && systemctl reload nginx
```

```powershell
# 你电脑
powershell -ExecutionPolicy Bypass -File scripts/run-tunnel-local.ps1 -Host root@<你的服务器IP>
```

```bash
# 服务器：把两条通道都指过去
bash set-gateway-url.sh https://<你的服务器IP>:8898 <网关令牌>
bash set-tts-url.sh     https://<你的服务器IP>:8898/v1
```

**切回 Cloudflare**

```bash
bash set-gateway-url.sh https://<你的>.trycloudflare.com <网关令牌>
bash set-tts-url.sh     https://<你的>.trycloudflare.com/v1
mv /etc/nginx/conf.d/sing-gateway.conf /etc/nginx/conf.d/sing-gateway.conf.disabled
nginx -t && systemctl reload nginx
```

> 宿主的 `NODE_EXTRA_CA_CERTS=/opt/qq-agent/tls/ca.crt` 一直留着没坏处（只影响自签那几条链路）。
> 证书链坏了（CA 重建过）就跑 `bash reissue-server-cert.sh`。

### 关于「只能唱 30 秒」

30 秒几乎都是 **iTunes 试听段** 的长度（Apple 只提供 30 秒 preview）。出现顺序是：

```
网易云搜歌 → 第 1 条是 VIP 原唱（拿不到直链）
           → 旧行为：立刻退回 iTunes 试听段（30 秒）❌
           → 新行为：先试其它网易云候选（常常有完整翻唱版/现场版），实在都没有才用试听段 ✅
```

另外歌词/音频完整度还取决于音源本身：`voiceMessageDefaultSeconds`（默认 90）只决定"要唱多久"，
源只有 30 秒就只能出 30 秒。想要原唱完整版，在 `gateway/config.json` 填 `source.neteaseCookie`（VIP）。

---

## 十一、网易云扫码登录（拿 VIP 曲的原唱）

不登录时：只能唱**免费曲**；VIP 曲会提示"需要 VIP"（以前会偷偷退回 30 秒试听，现在不会了）。

登录方式（不用手抄 Cookie）：

1. 打开 `https://<你的网关地址>/login?token=<网关令牌>`（本机就是 `http://127.0.0.1:8899/login?token=…`）
2. 用手机**网易云 App** 扫页面上的二维码
3. 手机上点「确认登录」，页面显示成功即可

网关会把 `MUSIC_U` 写回 `gateway/config.json` 的 `source.neteaseCookie`，立即生效、重启也在。
群里也可以直接问机器人：**「网易云怎么登录」** → 它会调 `netease_login` 把链接给你。

> 二维码用的是网易云官方二维码登录接口，二维码在**本地**由内置库渲染，
> 登录 key 不会经过任何第三方服务。

---

## 十二、需要截图的地方（写文档/发帖时用）

按这个顺序截，信息最全、也不暴露隐私：

| # | 位置 | 截什么 | 注意 |
|---|---|---|---|
| 1 | 控制台 → 插件 → 点歌唱歌 | 插件卡片 + 「已启用」状态 + 四个工具名 | 别把「网关令牌」框截进去（截到也请打码） |
| 2 | 控制台 → 设置 → 语音回复 (TTS) | 服务地址 `…/v1`、模型/音色 `hanser`、超时 180000 | **API Key 打码**；域名可以打码成 `https://***.trycloudflare.com` |
| 3 | 网关的 `/login` 页面 | 二维码 + "请用网易云 App 扫一扫" | 二维码最好打码（扫了会用你的账号登录） |
| 4 | QQ 群里的实际效果 | 用户那句「用语音唱一首雨爱」+ 收到的语音条 | 群名/昵称打码；这条最能说明"能用" |
| 5 | 网关控制台窗口 | `点歌网关 v0.1.0 已启动` + `[req] · POST /v1/audio/speech → 200 (24s)` | 这条是"链路真的通了"的证据 |
| 6 | （可选）`sing-model` 目录 | 权重与模型文件摆位 | 别截图 `downloads/`（3GB 缓存，看着吓人） |

> 建议顺序：**2 → 1 → 4 → 3**（先看配置，再看群效果，最后看登录）。

---

## License

MIT。模型、音源、音色的许可与版权请自行确认。