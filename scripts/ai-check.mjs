/**
 * AI 配置自检：检查 Key / Base / 模型名是否可用，并验证 JSON 输出模式
 * 用法：node scripts/ai-check.mjs
 * 依次读取：环境变量 → .env → 设置页保存的配置
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSetting } from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 1) continue
    const k = line.slice(0, i).trim()
    let v = line.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!process.env[k]) process.env[k] = v
  }
}

const envKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || ''
const base = (process.env.AI_API_BASE || process.env.OPENAI_BASE_URL || getSetting('apiBase') || 'https://api.deepseek.com').replace(/\/+$/, '')
const key = envKey || getSetting('apiKey') || ''
const model = process.env.AI_MODEL || getSetting('model') || 'deepseek-flash'
const source = envKey ? '.env / 环境变量' : (getSetting('apiKey') ? '设置页' : '未配置')

const mask = (k) => (k ? `${k.slice(0, 4)}***${k.slice(-4)}（${k.length}位）` : '（空）')
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1) }

console.log('AI 配置：')
console.log(`  Base : ${base}`)
console.log(`  Model: ${model}`)
console.log(`  Key  : ${mask(key)}  来源: ${source}`)
if (!key) fail('未配置 API Key。请在 .env 里填写 AI_API_KEY=sk-xxx，或在「设置」页填写后保存。')

const headers = { Authorization: `Bearer ${key}` }

// 1) 校验 Key 并列出可用模型（OpenAI 兼容的 /models 接口）
try {
  const res = await fetch(`${base}/models`, { headers })
  if (res.status === 401 || res.status === 403) fail(`API Key 无效或权限不足（HTTP ${res.status}）。`)
  if (!res.ok) {
    console.log(`  /models 返回 HTTP ${res.status}（部分服务不提供该接口，继续测试对话接口）`)
  } else {
    const data = await res.json()
    const ids = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean)
    console.log(`  可用模型（${ids.length}）：${ids.slice(0, 12).join(', ')}`)
    if (ids.length && !ids.some(id => id === model || id.startsWith(model))) {
      console.log(`  ⚠ 未在列表中精确匹配到「${model}」，若紧接着的对话测试失败，请改用上面列表里的 ID`)
    }
  }
} catch (e) {
  console.log(`  无法访问 /models：${e.message}`)
}

// 2) 校验对话 + JSON 模式（分析功能依赖 response_format=json_object）
try {
  const started = Date.now()
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '只输出 JSON，不要任何解释。' },
        { role: 'user', content: '输出 {"ok":true,"model":"你的模型名"}' },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    let hint = ''
    if (res.status === 401) hint = 'Key 无效'
    else if (/model/i.test(text) && /(not|invalid|exist)/i.test(text)) {
      hint = '模型名无效。DeepSeek 可用：deepseek-flash（V4.1-Flash）、deepseek-v4-pro'
    } else if (res.status === 402) hint = '额度不足'
    else if (res.status === 429) hint = '限流'
    fail(`对话接口返回 HTTP ${res.status}：${text.slice(0, 200)}${hint ? `\n  提示：${hint}` : ''}`)
  }
  const data = JSON.parse(text)
  const content = data.choices?.[0]?.message?.content || ''
  let parsed = null
  try { parsed = JSON.parse(content) } catch { /* 下面统一提示 */ }
  console.log(`\n✓ 对话调用成功，耗时 ${Date.now() - started}ms，模型返回：${content.slice(0, 120)}`)
  console.log(parsed ? '✓ JSON 模式可用（支持 response_format=json_object）' : '⚠ 返回内容不是合法 JSON，分析功能可能解析失败')
  console.log('\n配置可用，可以回到工作台开始 JD 分析了。')
} catch (e) {
  fail(`对话调用失败：${e.message}`)
}
