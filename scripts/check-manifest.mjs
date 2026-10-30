#!/usr/bin/env node
// 清单自检（不依赖宿主仓库，CI 和本地都能跑）：
//   node scripts/check-manifest.mjs plugin/sing
//
// 只查"发布前一定会翻车"的那些点：目录名与 id 不一致、entry 不存在、
// 能力写错、工具重名、设置项缺字段、占位符没填。
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_CAPABILITIES = new Set([
  'tools', 'schedule', 'log', 'config', 'secrets', 'http', 'media', 'send', 'approval', 'quota', 'feed'
]);
const ALLOWED_FIELD_TYPES = new Set(['text', 'number', 'boolean', 'select', 'secret']);

const dir = path.resolve(process.argv[2] || 'plugin/sing');
const problems = [];
const warn = [];
const fail = (msg) => problems.push(msg);

if (!fs.existsSync(dir)) {
  console.error(`✗ 目录不存在：${dir}`);
  process.exit(2);
}

const manifestPath = path.join(dir, 'plugin.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`✗ ${dir} 里没有 plugin.json（Linux 上注意大小写）`);
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`✗ plugin.json 不是合法 JSON：${error.message}`);
  process.exit(2);
}

// ── 基本字段 ────────────────────────────────────────────────
const id = String(manifest.id ?? '');
if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`id 只能是小写字母/数字/连字符，当前是 ${JSON.stringify(manifest.id)}`);
if (id && id !== path.basename(dir)) fail(`id（${id}）和目录名（${path.basename(dir)}）不一致`);
if (Number(manifest.apiVersion) !== 2) fail(`apiVersion 必须是 2，当前是 ${manifest.apiVersion}`);
if (!/^\d+\.\d+\.\d+/.test(String(manifest.version ?? ''))) fail(`version 不是 semver：${manifest.version}`);
if (!String(manifest.name ?? '').trim()) fail('缺少 name（控制台显示用的名字）');

// 上架要求：作者与主页不能是占位符
const author = String(manifest.author ?? '');
if (!author.trim()) fail('缺少 author（上架要求填真实作者）');
else if (/^<.*>$/.test(author)) fail('author 还是 <占位符>');
const homepage = String(manifest.homepage ?? '');
if (!homepage.trim()) warn.push('没填 homepage（索引里会显示占位符）');
else if (/^<.*>$/.test(homepage)) fail('homepage 还是 <占位符>');

// ── 入口文件 ────────────────────────────────────────────────
const entry = String(manifest.entry ?? '');
if (!entry) fail('缺少 entry（入口文件，一般是 index.mjs）');
else if (!fs.existsSync(path.join(dir, entry))) fail(`entry 指向的文件不存在：${entry}`);

// ── 能力 ────────────────────────────────────────────────────
const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
if (!caps.length) fail('capabilities 为空：插件至少要有 tools');
for (const cap of caps) {
  if (!ALLOWED_CAPABILITIES.has(String(cap))) fail(`未知能力：${cap}（宿主不认识它，就不会授权）`);
}

// ── 工具 ────────────────────────────────────────────────────
const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
const seen = new Set();
for (const tool of tools) {
  const name = String(tool?.name ?? '');
  if (!/^[a-z][a-z0-9_]*$/.test(name)) fail(`工具名不合法：${JSON.stringify(name)}`);
  if (seen.has(name)) fail(`工具重名：${name}`);
  seen.add(name);
  if (!String(tool?.description ?? '').trim()) fail(`工具 ${name} 没有 description（模型靠它选工具）`);
  if (!caps.includes('tools')) fail(`声明了工具但 capabilities 里没有 tools`);
}

// ── 设置项 ──────────────────────────────────────────────────
const groups = Array.isArray(manifest.settings?.groups) ? manifest.settings.groups : [];
const fieldKeys = new Set();
for (const group of groups) {
  if (!String(group?.key ?? '').trim()) fail('设置分组缺 key');
  if (!String(group?.title ?? '').trim()) fail(`设置分组 ${group?.key} 缺 title`);
  for (const field of Array.isArray(group?.fields) ? group.fields : []) {
    const key = String(field?.key ?? '');
    if (!key) fail(`分组 ${group?.key} 里有设置项缺 key`);
    if (fieldKeys.has(key)) fail(`设置项 key 重复：${key}`);
    fieldKeys.add(key);
    if (!ALLOWED_FIELD_TYPES.has(String(field?.type))) fail(`设置项 ${key} 的 type 不认识：${field?.type}`);
    if (!String(field?.label ?? '').trim()) fail(`设置项 ${key} 缺 label`);
  }
}
if (fieldKeys.size && !caps.includes('config')) fail('声明了设置项但 capabilities 里没有 config');

// ── 周期任务 ────────────────────────────────────────────────
for (const task of Array.isArray(manifest.schedule) ? manifest.schedule : []) {
  if (!String(task?.name ?? '').trim()) fail('schedule 里有任务缺 name');
  if (!(Number(task?.everyMs) >= 60000)) fail(`schedule ${task?.name} 的 everyMs 至少 60000`);
}
if ((manifest.schedule ?? []).length && !caps.includes('schedule')) fail('声明了周期任务但 capabilities 里没有 schedule');

// ── 汇总 ────────────────────────────────────────────────────
if (warn.length) for (const w of warn) console.warn(`⚠ ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`✓ ${id} v${manifest.version}：${tools.length} 个工具，${groups.length} 个设置分组，能力 ${caps.length} 项`);
