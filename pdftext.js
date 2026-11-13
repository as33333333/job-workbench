import pdfParse from 'pdf-parse'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/* =========================================================================
 * PDF 文本提取
 * - pdf-parse 默认按「y 完全相同才换行」拼接，双栏/设计类简历容易错行、漏行
 *   这里改为：按 y 聚行（容差 2）→ 行内按 x 排序 → 间距大时补空格
 * - 提取后统一清洗控制字符（PDF 里常见 \x01 等），并给出「解析质量」判定，
 *   避免把「只解析到抬头 91 字」的简历当作完整材料送进分析
 * ========================================================================= */

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export function cleanText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(CONTROL_CHARS, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function renderPage(pageData) {
  const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
  const items = (content.items || [])
    .filter(it => it && typeof it.str === 'string' && it.str.length && Array.isArray(it.transform))
    .map(it => ({ str: it.str, x: it.transform[4] ?? 0, y: it.transform[5] ?? 0, w: Number(it.width) || 0 }))
    .sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x))

  const lines = []
  let cur = null
  for (const it of items) {
    if (!cur || Math.abs(it.y - cur.y) > 2) {
      cur = { y: it.y, parts: [it] }
      lines.push(cur)
    } else cur.parts.push(it)
  }

  return lines.map(line => {
    const parts = [...line.parts].sort((a, b) => a.x - b.x)
    let text = ''
    let prevEnd = null
    for (const p of parts) {
      // 同一行里两块文字间距明显（大于 1.5pt）时补一个空格，避免「负责A负责B」粘在一起
      if (prevEnd !== null && p.x - prevEnd > 1.5 && text && !/\s$/.test(text)) text += ' '
      text += p.str
      prevEnd = p.x + p.w
    }
    return text
  }).join('\n')
}

/* 纯函数：根据字符数与页数判断解析质量（可离线断言） */
export function assessText({ text = '', pages = 0, source = 'pdf' } = {}) {
  const chars = cleanText(text).length
  const pageCount = Number(pages) || 0
  const charsPerPage = pageCount > 0 ? Math.round(chars / pageCount) : chars
  const warnings = []
  let level = 'ok'
  if (chars < 10) level = 'empty'
  else if (pageCount > 0 && charsPerPage < 120) level = 'low'
  else if (pageCount > 0 && charsPerPage < 200) level = 'thin'

  if (level === 'empty') {
    warnings.push('没有提取到任何文字：这份 PDF 很可能是扫描件或纯图片，需要改用「粘贴文本」，或导出成文字版 PDF / Word')
  } else if (level === 'low') {
    warnings.push(`每页只提取到约 ${charsPerPage} 字，正文很可能是图片或字体无法提取；直接用于分析会因材料缺失被判「信息不足」或低估你`)
  } else if (level === 'thin') {
    warnings.push(`每页约 ${charsPerPage} 字，偏少；请在预览里确认工作经历是否都提取到了`)
  }
  return {
    source, pages: pageCount, chars, charsPerPage,
    level, suspicious: level !== 'ok', warnings,
  }
}

export async function extractPdf(buf) {
  const out = await pdfParse(buf, { pagerender: renderPage })
  const text = cleanText(out.text)
  const meta = assessText({ text, pages: out.numpages || 0 })
  return { text, meta }
}

/* ============================ 系统 OCR 兜底 ============================
 * 设计类/扫描版简历常常「只有图片没有文字层」，或字体无法提取（pdf.js 会报
 * "Ran out of space in font private use area"），只解析到抬头几十字。
 * 这里用 macOS 自带 Vision（swift 编译一次到 data/bin/pdf-ocr）做逐页 OCR，
 * 不上传任何文件，也不引入 npm 依赖。
 * ==================================================================== */
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const OCR_SRC = path.join(ROOT, 'scripts', 'pdf-ocr.swift')
const OCR_BIN = path.join(ROOT, 'data', 'bin', 'pdf-ocr')

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 180_000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).split('\n')[0] || 'OCR 失败'))
      resolve(stdout)
    })
  })
}

export function ocrAvailable() {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/swiftc')
}

/* 优先用编译好的二进制（快）；首次或源码更新后编译一次 */
async function ensureOcrBinary() {
  if (!ocrAvailable()) throw new Error('当前系统不支持本地 OCR（需要 macOS + Swift）')
  const src = fs.statSync(OCR_SRC)
  if (fs.existsSync(OCR_BIN) && fs.statSync(OCR_BIN).mtimeMs >= src.mtimeMs) return OCR_BIN
  fs.mkdirSync(path.dirname(OCR_BIN), { recursive: true })
  await run('/usr/bin/swiftc', ['-O', OCR_SRC, '-o', OCR_BIN])
  return OCR_BIN
}

export async function ocrPdfFile(filePath, { maxPages = 15 } = {}) {
  const bin = await ensureOcrBinary()
  const out = await run(bin, [filePath, String(maxPages)])
  return cleanText(out)
}

/* 完整流程：先取文字层；文字层不足（空/每页过少）时自动 OCR，取字符更多的结果 */
export async function extractPdfSmart(buf, { filePath = '', forceOcr = false, maxOcrPages = 15 } = {}) {
  let textResult = { text: '', meta: assessText({ text: '', pages: 0 }) }
  try { textResult = await extractPdf(buf) } catch (e) { textResult = { text: '', meta: { ...assessText({ text: '' }), error: e.message } } }

  const needOcr = forceOcr || textResult.meta.level !== 'ok'
  if (!needOcr) return { ...textResult, meta: { ...textResult.meta, method: 'text' } }

  if (!filePath || !ocrAvailable()) {
    return { ...textResult, meta: { ...textResult.meta, method: 'text', ocrSkipped: !filePath ? 'no-file' : 'unsupported' } }
  }
  try {
    const ocrText = await ocrPdfFile(filePath, { maxPages: maxOcrPages })
    if (ocrCleanBetter(ocrText, textResult.text)) {
      return { text: ocrText, meta: { ...assessText({ text: ocrText, pages: textResult.meta.pages || 1 }), method: 'ocr' } }
    }
    return { ...textResult, meta: { ...textResult.meta, method: 'text', ocrTried: true } }
  } catch (e) {
    return { ...textResult, meta: { ...textResult.meta, method: 'text', ocrError: e.message } }
  }
}

/* 纯函数：OCR 结果是否值得替换文字层（避免把乱码文字层换成更差的 OCR） */
export function ocrCleanBetter(ocrText, textText) {
  const a = cleanText(ocrText).length
  const b = cleanText(textText).length
  return a >= 30 && a >= b * 1.3
}
