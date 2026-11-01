#!/usr/bin/env node
// 领取 BreezeBlue 每日签到额度（网页控制台那个 Claim now）
//
// 背景：签到没有开发者 API。网页控制台的接口是
//   POST https://breezeblue.ai/api/credits/daily-claim
//   鉴权是会话 Cookie（前端用 credentials:"include"），不认 API Key。
//
// 好消息：这个站是"邮箱密码走自家服务器"（/api/config 里 email_auth_mode=server），
// 登录不需要 Firebase / Google —— 直接 POST /api/auth/email/continue 就能拿到会话 Cookie。
//
// 用法：
//   1) 准备凭据，二选一：
//        环境变量：setx BREEZE_EMAIL "you@example.com" && setx BREEZE_PASSWORD "密码"
//        文件    ：%USERPROFILE%\.breeze-login.json  →  {"email":"...","password":"..."}
//   2) 运行：
//        node scripts/claim-daily-credits.mjs                  # 领 +400（需已加入 Discord）
//        node scripts/claim-daily-credits.mjs --tier standard  # 领 +100（不加入 Discord）
//        node scripts/claim-daily-credits.mjs --status         # 只查登录态和额度
//
// 说明：
//   * 全程只访问 breezeblue.ai，不碰 Google；
//   * 会话 Cookie 落在 %USERPROFILE%\.breeze-session（下次可复用，省一次登录）；
//   * 带上 Origin 头，否则服务端会 403（防 CSRF）。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ORIGIN = 'https://breezeblue.ai';
const LOGIN_URL = `${ORIGIN}/api/auth/email/continue`;
const CLAIM_URL = `${ORIGIN}/api/credits/daily-claim`;
const SUMMARY_URL = `${ORIGIN}/api/credits/summary`;

const args = process.argv.slice(2);
const tier = args.includes('--tier') ? args[args.indexOf('--tier') + 1] : 'discord';
const statusOnly = args.includes('--status');
const cookieJar = path.join(homedir(), '.breeze-session');

function readCreds() {
  const email = String(process.env.BREEZE_EMAIL || '').trim();
  const password = String(process.env.BREEZE_PASSWORD || '');
  if (email && password) return { email, password };
  const file = path.join(homedir(), '.breeze-login.json');
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.email && data.password) {
        return { email: String(data.email).trim(), password: String(data.password) };
      }
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 用 curl 发请求；jar 传文件路径就复用/保存会话 Cookie。 */
async function call(url, { method = 'GET', body = null, jar = null, saveJar = null } = {}) {
  const argv = ['-sS', '--ssl-no-revoke', '-m', '40', '-X', method, '-w', '\n%{http_code}',
    '-H', `origin: ${ORIGIN}`, '-H', `referer: ${ORIGIN}/app/studio`];
  if (jar) argv.push('-b', jar);
  if (saveJar) argv.push('-c', saveJar);
  if (body !== null) argv.push('-H', 'content-type: application/json', '--data-binary', JSON.stringify(body));
  argv.push(url);
  let stdout = '';
  let stderr = '';
  try {
    const res = await run('curl', argv, { maxBuffer: 4 * 1024 * 1024 });
    stdout = res.stdout;
    stderr = res.stderr || '';
  } catch (error) {
    // curl 超时/连不上时 execFile 会 reject，这里降级成 status 0 而不是抛出去
    stdout = String(error?.stdout || '');
    stderr = String(error?.stderr || error?.message || '');
  }
  const cut = stdout.lastIndexOf('\n');
  const status = cut >= 0 ? Number(stdout.slice(cut + 1).trim()) || 0 : 0;
  const text = (cut >= 0 ? stdout.slice(0, cut) : stdout).trim() || stderr.trim();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status, text, json };
}

/** 带重试的调用：网络类失败（status 0）最多试 3 次。 */
async function callRetry(url, options = {}, attempts = 3) {
  let last = null;
  for (let i = 1; i <= attempts; i += 1) {
    last = await call(url, options);
    if (last.status !== 0) return last;
    if (i < attempts) {
      console.log(`  · 第 ${i} 次网络失败，2 秒后重试…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return last;
}

const creds = readCreds();
let jar = existsSync(cookieJar) ? cookieJar : null;

if (!creds && !jar) {
  console.error('✗ 没有凭据。设置 BREEZE_EMAIL / BREEZE_PASSWORD，或写 ~/.breeze-login.json');
  process.exit(2);
}

if (creds) {
  console.log(`▶ 登录（${creds.email}）…`);
  const login = await callRetry(LOGIN_URL, { method: 'POST', body: creds, saveJar: cookieJar });
  if (login.status !== 200) {
    console.error(`✗ 登录失败 HTTP ${login.status}：${String(login.json?.detail || login.text).slice(0, 200)}`);
    if (login.status === 403) console.error('  提示：Origin 校验失败（脚本已带 origin 头，理论上不该出现）');
    if (login.status === 422) console.error('  提示：密码不对，或新账号要求至少 8 位密码');
    process.exit(1);
  }
  console.log(`✓ 登录成功（会话已保存到 ${cookieJar}）`);
  jar = cookieJar;
}

const summary = await callRetry(SUMMARY_URL, { jar });
if (summary.status === 200 && summary.json) {
  const s = summary.json;
  const balance = s.balance ?? s.credits ?? s.available ?? JSON.stringify(s).slice(0, 140);
  console.log(`· 当前额度：${balance}`);
} else {
  console.log(`· 查额度失败 HTTP ${summary.status}：${String(summary.json?.detail || summary.text).slice(0, 160)}`);
}

if (statusOnly) process.exit(0);

async function claimOnce(useTier) {
  console.log(`▶ 领取每日奖励（tier=${useTier}）…`);
  const res = await callRetry(CLAIM_URL, { method: 'POST', body: { reward_tier: useTier }, jar });
  console.log(`  HTTP ${res.status}：${(res.text || '(空)').slice(0, 320)}`);
  return res;
}

let claim = await claimOnce(tier);
// +400 那档要求绑定 Discord；没绑会自动掉到 +100，这里显式兜一次底
if (claim.status !== 200 && tier !== 'standard' && !/already|claimed/i.test(claim.text) && claim.status !== 409) {
  console.log('· 高额度那档失败（可能没绑 Discord），改用 standard 再试一次');
  claim = await claimOnce('standard');
}

const body = claim.json || {};
if (claim.status === 200 && body.claimed === true) {
  console.log(`✓ 领取成功 +${body.credits_issued ?? '?'}，当前额度 ${body.balance ?? '?'}`);
  console.log(`  下一轮：${body.daily_claim_next_reset_at || '未知'}`);
} else if (claim.status === 200 && body.already_claimed === true) {
  console.log(`· 这一轮已经领过了，额度 ${body.balance ?? '?'}；下一轮 ${body.daily_claim_next_reset_at || '未知'}`);
} else if (claim.status === 409 || /already|claimed/i.test(claim.text)) {
  console.log('· 这一轮已经领过了');
} else {
  console.log('✗ 没领成');
  process.exitCode = 1;
}
