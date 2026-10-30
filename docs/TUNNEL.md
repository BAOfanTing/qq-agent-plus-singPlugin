# 把本机网关暴露成 https

> ⚠️ **快速隧道（trycloudflare 匿名隧道）有个硬约束：源站超过约 100 秒没响应，Cloudflare 就回 `524`。**
> 唱歌要几十秒到一分半（整首 4 分钟约 83 秒，再排个队就越线），**所以语音条那条通道不要走快速隧道**。
>
> | 通道 | 走哪 | 原因 |
> |---|---|---|
> | 插件（`/sing`、`/jobs`、`/files`、`/login`） | 快速隧道可以 | 都是短请求（202 + 轮询 + 下载） |
> | 宿主语音条（`/v1/audio/speech`） | **本机 8898 专线**（ssh -R + nginx TLS）或 named tunnel | 宿主同步等音频，几十秒起步，快速隧道必然 524 |
>
> 语音条走 `https://127.0.0.1:8898/v1` 还有个好处：不经第三方、地址永不变。配置见文末「备用专线」一节。

**为什么不能直接填 `http://127.0.0.1:8899`：** 宿主给插件的联网能力写死了 `allowPrivate: false`
（见 qq-agent-plus `src/plugins/capabilities.js` 里 `cap.http.request` / `cap.media.download` 的调用），
`localhost`、`127.0.0.1`、`192.168.x.x`、`10.x.x.x` 一律 `禁止访问内网/本机地址`。
这不是插件的选择，改不了 —— 所以网关必须有一个**公网域名 + https**。

好消息是：三种做法都不需要家里有公网 IP。

## 方案一：Cloudflare Tunnel（推荐，免费、自动证书）

```bash
# 一次性安装：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://127.0.0.1:8899
```

输出里会有一行：

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:                                          |
|  https://random-words-here.trycloudflare.com                                               |
+--------------------------------------------------------------------------------------------+
```

把这个地址填进插件设置即可。**注意：**
- 快速隧道（`--url` 不带登录）每次重启地址都会变 → 适合先试；要固定域名用
  `cloudflared tunnel login` + `cloudflared tunnel create sing` + 本地 `config.yml` 绑一个自己的子域；
- 隧道是公网可达的，**token 一定要设**（`gateway/config.json` 的 `token`，插件里填同一个值）。

固定域名的 `config.yml` 长这样：

```yaml
tunnel: sing
credentials-file: C:\Users\你\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: sing.example.com
    service: http://127.0.0.1:8899
  - service: http_status:404
```

## 方案二：frp（有便宜 VPS 的话最灵活）

家里电脑跑 `frpc`，VPS 跑 `frps` + nginx 反代（要 https 证书，Let's Encrypt 即可）：

```ini
# frpc.ini（家里）
[sing]
type = http
local_port = 8899
custom_domains = sing.example.com
```

```nginx
# VPS 上的 nginx
server {
  server_name sing.example.com;
  location / {
    proxy_pass http://127.0.0.1:8080;   # frps 的 vhost 端口
    client_max_body_size 100m;
    proxy_read_timeout 120s;
  }
  # 证书交给 certbot / acme.sh
}
```

## 方案三：同一台服务器上反代（不推荐）

你已经有 <你的服务器IP> 这台公网服务器。理论上可以 `ssh -R 8899:127.0.0.1:8899` 把家里端口反向映射到
服务器，再用 nginx + 自签证书暴露成 `https://<你的服务器IP>:8443`。**但：**

- 插件的 `httpDomains` 默认走"公网但禁内网"的守卫，直接填 IP 会被判定为公网 IP 而放行 ——
  等于把点歌网关挂到公网裸奔，只靠 token 挡；
- 自签证书在宿主侧会报 TLS 错误，得配真证书；
- 反向隧道断了要人肉重连。

要这么做，务必：① 只监听 `127.0.0.1`；② 用 nginx 加 `limit_req`；③ 或者干脆用方案一/二。

## 开机自启（Windows）

两个计划任务，登录时触发、失败重试：

```powershell
# 网关
schtasks /create /tn "SingGateway" /tr "node E:\Cache\qq-agent\qq-agent-plus-SingPlugin\gateway\server.mjs" /sc onlogon /rl highest
# 隧道（固定域名版本）
schtasks /create /tn "SingTunnel"  /tr "cloudflared tunnel run sing" /sc onlogon /rl highest
```

Linux 用 systemd user 服务（和你跑 qq-agent 的方式一致）：

```ini
# ~/.config/systemd/user/sing-gateway.service
[Unit]
Description=Sing gateway
[Service]
ExecStart=/usr/bin/node /opt/sing/gateway/server.mjs
Restart=always
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now sing-gateway
loginctl enable-linger "$USER"
```

## 排查

| 现象 | 先查什么 |
|---|---|
| 插件说「网关返回失败：HTTP 502」 | 隧道进程活着但网关没起来 → 本机 `curl http://127.0.0.1:8899/health` |
| 插件说「禁止访问内网/本机地址」 | 网关地址填成了 `http://127.0.0.1:...` 或内网 IP，换成 https 域名 |
| 插件说「令牌不对」 | 插件设置里的「网关令牌」与 `config.json` 的 `token` 不一致 |
| 隧道地址每次重启都变 | 用的是快速隧道，改固定域名方案 |

---

## 备用专线：ssh -R + nginx TLS（地址永不变）

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
