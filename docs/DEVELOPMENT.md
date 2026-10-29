# 开发与测试

```bash
node --test            # 35 个用例：插件纯函数 / 网关队列 / 网关路由 / 真协议集成
node gateway/server.mjs

# 宿主侧的验证工具（在 qq-agent-plus 仓库里跑）
node scripts/plugin-validate.mjs <本仓库>/plugin/sing
node scripts/plugin-dev.mjs <本仓库>/plugin/sing --call sing_status
```

契约见 [PROTOCOL.md](PROTOCOL.md)；想换后端（Python/Go 都行）只需实现同样的五个接口。
