# 三步跑起来

前提：源码已有、Python 环境装好（`conda activate sing`）、Breeze 权重放进 `say-model/weights/breeze-tts-2/`。

---

## ① 装依赖（一条命令）

```powershell
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

> 说话只走云端的话，可以只装 `fastapi uvicorn`，跳过 torch/triton（见 [ENV.md](ENV.md)）。
> 国内下 torch 那个 2.67 GB 轮子慢，文件头有手动下载的做法。

---

## ② 一键启动（一条命令）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
```

它自己会做完这些事：

| 步骤 | 说明 |
|---|---|
| 找 node / python | 找不到会直接告诉你 |
| 体检权重 | 跑 `say-model/check-ckpt.py`，缺文件会点名 |
| 生成配置 | `gateway/config.json` 不存在就从示例生成，**自动填随机令牌 + python 路径 + 权重路径** |
| 起网关 | 首次前台跑（Ctrl+C 停）；代码没报错就对了 |
| 起隧道 | 起 `cloudflared` 快速隧道，等它给出 https 地址 |
| 打印下一步 | 隧道地址、网关令牌、服务器上要跑的两条命令，直接复制 |

想常驻（关终端也不停）加 `-Detach`；暂时不要隧道加 `-NoTunnel`。

没装 cloudflared？脚本会给你这条命令：

```powershell
curl.exe -L -o tools\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
```

---

## ③ 指过去 + 试

**一条命令**（在你电脑上跑，脚本会自己读隧道地址和令牌，再 ssh 到服务器改配置）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<你的服务器IP>
```

它做完三件事：把新隧道地址写进插件 `gatewayUrl`、写进宿主 `tts.baseUrl`、并跑一次真链路自检。

> 想手动改也行（服务器上）：
> ```bash
> bash /opt/qq-agent/set-gateway-url.sh https://<隧道地址> <网关令牌>
> bash /opt/qq-agent/set-tts-url.sh     https://<隧道地址>/v1
> ```

然后在控制台 → 插件 → 点歌唱歌里确认「网关地址」「网关令牌」已填好。
走云端说话的话，再到「说话（Breeze 云端）」填 API Key 与音色 id。

群里试两句：

- `说句话` → 收到**语音条**（不是文字回退）
- `用语音唱一首夜曲` → 20-40 秒后收到整首

---

# 到此就完了。下面是备注

## 隧道地址变了怎么办

Cloudflare 快速隧道每次重启都会换地址。变了就跑一遍：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-host-url.ps1 -SshHost root@<IP>
```

它从 `logs\cloudflared.log` 里读最新地址并同步到服务器，不用手抄。

嫌麻烦就改用 **ssh -R 专线**（地址永不变、无 100 秒上限），见 [TUNNEL.md](TUNNEL.md)「备用专线」。
实测快速隧道跑整首 3:54 只要 43 秒，**不会**撞上 100 秒上限；只有极端情况（模型冷启动 + 长歌）才会 524。

## 想改配置

`gateway/config.json`（已在 `.gitignore`，不会进版本库）：

| 字段 | 作用 |
|---|---|
| `token` | 网关令牌，插件里要填同一个 |
| `say.engine` | `breeze-local`（本地）/ `breeze`（云端）/ `none`（关掉） |
| `say.instructions` | 本地音色的文字描述，如「清亮通透的少女音，软糯但不嗲」 |
| `say.refAudio` + `refText` | 想克隆具体音色时填参考 wav 及其文稿（必须一字不差） |
| `say.breezeKey` / `voiceId` | 云端用；也可以在插件设置里填（插件会推到网关） |
| `say.localIdleMs` | 本地模型闲置多久退出，默认 `60000`（1 分钟）；`0` = 常驻不退 |
| `voice.defaultVoice` | 唱歌音色，即 `sing-model/weights` 里 `.pth` 的文件名 |

改完重启：`schtasks /End /TN QQAgentSingGateway` → `schtasks /Run /TN QQAgentSingGateway`
（前台模式就直接 Ctrl+C 再跑一次）

## 四条自检

```powershell
curl http://127.0.0.1:8899/health
curl -H "authorization: Bearer <令牌>" http://127.0.0.1:8899/say/status
curl -X POST -H "authorization: Bearer <令牌>" -H "content-type: application/json" -d '{"input":"测试一句话"}' http://127.0.0.1:8899/v1/audio/speech -o t.mp3
curl -X POST -H "authorization: Bearer <令牌>" -H "content-type: application/json" -d '{"input":"唱：夜曲","maxSeconds":30}' http://127.0.0.1:8899/v1/audio/speech -o s.mp3
```

## 常见报错

| 报错 | 原因 |
|---|---|
| `No module named 'triton'` | 没装 `triton-windows==3.5.1.post24` |
| `torch.cuda.is_available() == False` | 装成 PyPI 的 CPU 版 torch，按 ① 重装 |
| `Template 'ref_clone_tata' does not define a negative prompt but cfg_scale=4.0` | 参考克隆不支持 CFG；网关已自动压到 1 |
| 宿主报 `HTTP 524` | 通道太慢（极少见），改用 ssh -R 专线 |
| 宿主报 `上传文件失败 ENOENT` | 容器内 `/app/data` 与 `/opt/qq-agent/data` 没打通，见 [INSTALL.md](INSTALL.md) |
| 插件说「说话后端离线」 | 网关没开 / 令牌不对 / Breeze Key 无效，先跑四条自检 |
