/* 用真实 PDF 走一遍 /api/documents/parse 预览，不做入库 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const file = process.argv[2]
const base = process.argv[3] || 'http://127.0.0.1:8788'
const ocr = process.argv.includes('--ocr')
if (!file) {
  console.error('用法: node scripts/parse-check.mjs <pdf路径> [服务地址] [--ocr]')
  process.exit(1)
}

const buf = readFileSync(file)
const name = basename(file)
const t0 = Date.now()
const res = await fetch(`${base}/api/documents/parse`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fileName: name, fileBase64: buf.toString('base64'), ocr })
})
const ms = Date.now() - t0
const body = await res.json()
if (!res.ok) {
  console.log(JSON.stringify({ ok: false, status: res.status, error: body.error, ms }, null, 2))
  process.exit(1)
}

const text = body.text || ''
const meta = body.meta || {}
const lines = text.split('\n').filter((l) => l.trim())
const hit = (kws) => kws.filter((k) => text.includes(k))

console.log(JSON.stringify({
  ok: true,
  file: name,
  ms,
  chars: text.length,
  lines: lines.length,
  meta,
  sections: {
    工作经历: hit(['工作经历', '工作经验', '职业经历']),
    项目经历: hit(['项目经历', '项目经验', '产品经历']),
    教育: hit(['教育经历', '教育背景']),
    技能: hit(['专业技能', '技能', '能力']),
    年限: hit(['年经验', '年工作经验', '至今']),
    公司信号: hit(['有限公司', '科技', '集团', '事业部'])
  },
  head: text.slice(0, 600),
  tail: text.slice(-400)
}, null, 2))
