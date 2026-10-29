@echo off
rem 启动点歌网关（第一次会自动从 config.example.json 复制一份 config.json）
cd /d "%~dp0gateway"
if not exist config.json (
  copy config.example.json config.json >nul
  echo 已生成 gateway\config.json —— 请先改里面的 token，再重新运行本脚本。
  pause
  exit /b 1
)
node server.mjs
pause
