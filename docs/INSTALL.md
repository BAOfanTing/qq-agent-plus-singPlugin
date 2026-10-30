# 安装与部署

完整安装步骤。只想先跑起来，看 [README](../README.md) 的「快速开始」即可。

## 关掉之后怎么重新起（手动启动速查）

四个部分，按顺序起。**任何一步没起，群里点歌都会失败**（会明确报"后端离线"或"网关连不上"）。

### ① 电脑端：起网关

```powershell
cd E:\Cache\qq-agent\qq-agent-plus-SingPlugin
node gateway\server.mjs                       # 前台，能看每条 [req] 日志（推荐排错时用）
# 或双击 start-gateway.bat
# 或常驻：powershell -ExecutionPolicy Bypass -File scripts\run-gateway-forever.ps1
```

自检：

```powershell
curl http://127.0.0.1:8899/health
# 期望 ok:true、voiceConfigured:true、voices:[...]、voiceSeconds 符合预期
```

### ② 电脑端：把网关暴露成 https（二选一）

```powershell
# A. Cloudflare 快速隧道（域名每次变）
$env:CLOUDFLARED = "E:\Cache\qq-agent\tools\cloudflared.exe"
start-tunnel.bat
# 输出里找 https://xxx-xxx-xxx.trycloudflare.com
```

```powershell
# B. 专线（地址永不变，需要服务器上 nginx 8898 站点已启用）
ssh -i "$env:USERPROFILE\.ssh\dsh_ed25519_stats" -N -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 -R 127.0.0.1:8899:127.0.0.1:8899 root@<服务器IP>
# 常驻版：powershell -ExecutionPolicy Bypass -File scripts\run-tunnel-local.ps1 -Host root@<服务器IP>
```

> 专线要在服务器上先启用站点：
> `mv /etc/nginx/conf.d/sing-gateway.conf.disabled /etc/nginx/conf.d/sing-gateway.conf && nginx -t && systemctl reload nginx`

### ③ 服务器端：把地址填给插件和宿主

```bash
bash /opt/qq-agent/set-gateway-url.sh https://<第 2 步的地址> <网关令牌>
bash /opt/qq-agent/set-tts-url.sh     https://<第 2 步的地址>/v1
```

脚本会自己回读并打 `/health` 自检。**注意两条通道能用的地址不一样**：

| 谁 | 用什么地址 | 原因 |
|---|---|---|
| 插件（发群文件） | 必须是**公网**（Cloudflare 隧道） | 宿主 `cap.http` 禁用内网地址 |
| 宿主语音条 | `https://127.0.0.1:8898/v1`（专线）也可以用 | 服务器访问自己的公网 IP:8898 常被安全组挡 |

### ④ 验证

```bash
bash /opt/qq-agent/check-lines.sh      # 隧道口 / 8898 / 宿主 TTS 真链路
```

再在控制台 → 设置 → 语音回复 → 「试听」输入 `唱：歌名`，能听到声音就全通了。

---

| 章节 | 内容 |
|---|---|
| 0 | 目录结构 |
| 1-3 | 电脑端：Python 环境、RVC 资产、音色权重 |
| 4-6 | 电脑端：网关配置、启动、暴露 https |
| 7-10 | 服务器端：装插件、填设置、语音条通道、容器桥接 |
| 11 | 网易云扫码登录（VIP 曲原唱） |
| 12-13 | 开机自启、服务器 IPv6 加固 |
| 14 | 发帖/写文档时的截图清单 |

---

## 0. 目录结构

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
  plugin/sing/vendor/qrcode.cjs  插件自带的 QR 库（控制台「扫码登录」用；.cjs 是因为仓库是 type=module）
  lib/jobs.mjs        串行任务队列（带进度与 TTL）
sing-model/
  run.py              换声编排：裁剪 → 分离 → 换声 → 混伴奏（网关调的就是它）
  fetch-*.ps1         拉模型的脚本（分块/续传，国内镜像会断流）
  rvc/                新版 RVC 源码 + 权重（.gitignore 排除，不进仓库）
docs/PROTOCOL.md      插件 ↔ 网关 HTTP 契约（想用别的语言重写后端看这个）
docs/TUNNEL.md        把本机网关暴露成 https 的三种做法
docs/TROUBLESHOOTING.md  排错（含容器化 OneBot 发文件失败那个坑）
docs/TUNING.md       调优与踩坑笔记（时长四道闸、显存、历史踩坑、验收清单）
scripts/bridge-container-paths.sh  把插件媒体目录桥接进 OneBot 容器
start-gateway.bat / start-tunnel.bat  Windows 一键启动
test/                 32 个用例（含"子进程跑插件、测试扮演宿主"的真协议测试）
```

---

---

## 1. 部署总览与电脑端

### 总览：四件事

1. 电脑上装 RVC 环境 + 网关 → 本机 `127.0.0.1:8899` 能点歌；
2. 把网关暴露成 **https**（宿主强制禁内网，`127.0.0.1` 填不进去）；
3. 服务器上装插件、填设置；
4. （要发群文件的话）把插件媒体目录**桥接进 OneBot 容器**。

### 1.1 电脑端：Python 环境（RVC）

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

### 1.2 电脑端：RVC 资产

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

### 1.3 电脑端：放音色权重

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

### 1.4 电脑端：网关配置

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
| `voiceMessageMaxSeconds` | 语音条通道硬上限，默认 300 秒（插件推上来的值会被它夹紧） |
| `voiceMessageDefaultSeconds` | 语音条默认时长，默认 180 秒（插件没推值时用它；宿主调 `/audio/speech` 不带时长） |
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
  "transcode": "auto", "maxSeconds": 300, "voiceMessageMaxSeconds": 300, "voiceMessageDefaultSeconds": 180,
  "filesTtlHours": 24, "outputArtist": "小鲸鱼", "dataDir": "gateway-run"
}
```

### 1.5 电脑端：启动

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

### 1.6 暴露成 https（必须）

宿主给插件的联网能力写死 `allowPrivate:false`，`127.0.0.1`、`192.168.x.x` 一律拒绝。最省事：

```powershell
start-tunnel.bat
# 或手动：
cloudflared tunnel --url http://127.0.0.1:8899 --no-autoupdate
# 输出里形如 https://xxxx-yyyy.trycloudflare.com ← 这就是"网关地址"
```

**快速隧道的域名每次重启都变**，变了要去插件设置里改一次。要固定就用 named tunnel / frp，
见 [docs/TUNNEL.md](docs/TUNNEL.md)。

### 1.7 服务器端：装插件

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

### 1.8 服务器端：填设置

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

### 1.9 语音条通道：把宿主 TTS 指向网关

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

### 1.10 服务器端：把媒体目录桥接进 OneBot 容器（发群文件必须）

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

---

## 11. 网易云扫码登录（VIP 曲原唱）

不登录时：只能唱**免费曲**；VIP 曲会提示"需要 VIP"（以前会偷偷退回 30 秒试听，现在不会了）。

登录方式（不用手抄 Cookie）：

1. **控制台 → 插件 → 点歌唱歌 → 「扫码登录」**（推荐，二维码直接显示在插件页里）
   或者打开 `https://<你的网关地址>/login?token=<网关令牌>`（本机：`http://127.0.0.1:8899/login?token=…`）
2. 用手机**网易云 App** 扫页面上的二维码
3. 手机上点「确认登录」，页面显示成功即可

网关会把 `MUSIC_U` 写回 `gateway/config.json` 的 `source.neteaseCookie`，立即生效、重启也在。
群里也可以直接问机器人：**「网易云怎么登录」** → 它会调 `netease_login` 把链接给你。

> 二维码用的是网易云官方二维码登录接口，二维码在**本地**由内置库渲染，
> 登录 key 不会经过任何第三方服务。

---

---

## 12. 开机自启（Windows）

```powershell
schtasks /create /tn "SingGateway" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File E:\path\to\qq-agent-plus-SingPlugin\scripts\run-gateway-forever.ps1" /sc onlogon /rl highest
schtasks /create /tn "SingTunnel"  /tr "E:\Cache\qq-agent\tools\cloudflared.exe tunnel --url http://127.0.0.1:8899 --no-autoupdate" /sc onlogon /rl highest
```

> 隧道用快速模式时，**每次重启域名都会变** —— 变了跑一次 `set-gateway-url.sh`。
> 想彻底省事就换成固定域名（named tunnel），见 [docs/TUNNEL.md](docs/TUNNEL.md)。

---

## 13. 服务器侧 IPv6 加固（一次性）

服务器没有 IPv6 出口时，Node 的 fetch 会先试 AAAA，高峰期容易卡成 `fetch failed`：

```bash
mkdir -p ~qqagent/.config/systemd/user/qq-agent-linux.service.d
printf '[Service]\nEnvironment=NODE_OPTIONS=--dns-result-order=ipv4first\n' \
  > ~qqagent/.config/systemd/user/qq-agent-linux.service.d/ipv4first.conf
chown -R qqagent:qqagent ~qqagent/.config/systemd/user
su - qqagent -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user daemon-reload && systemctl --user restart qq-agent-linux'
```

---

## 14. 发帖/写文档时的截图清单

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
