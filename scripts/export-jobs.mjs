#!/usr/bin/env node
// 导出岗位库为 Markdown + JSON，方便分享或喂给其他 AI
import { listJobs } from '../db.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '..', 'export')
fs.mkdirSync(outDir, { recursive: true })

const jobs = listJobs()
const stamp = new Date().toISOString().slice(0, 10)

const salary = j => j.salaryText || (j.salaryMin ? `${j.salaryMin}-${j.salaryMax || '?'}K` : '面议')
const exp = j => j.experienceText || (j.recruitType === '校招' ? '应届' : '经验不限')

const md = []
md.push(`# 岗位库导出（${stamp}）`)
md.push('')
md.push(`> 共 ${jobs.length} 个岗位。来源：boss-zhipin-scraper 采集 + 手动导入。由「求职工作台」生成。`)
md.push('')
md.push('| # | 岗位 | 公司 | 薪资 | 城市 | 经验 | 学历 | 链接 |`)
md.push('|---|------|------|------|------|------|------|------|')
jobs.forEach((j, i) => {
  md.push(`| ${i + 1} | ${j.title} | ${j.company || '-'} | ${salary(j)} | ${j.city || '-'} | ${exp(j)} | ${j.education || '-'} | ${j.sourceUrl || '-'} |`)
})
md.push('')
md.push('---')
md.push('')
jobs.forEach((j, i) => {
  md.push(`## ${i + 1}. ${j.title}${j.company ? `｜${j.company}` : ''}`)
  md.push('')
  md.push(`- **薪资**：${salary(j)}${j.salaryNote ? `（${j.salaryNote}）` : ''}`)
  md.push(`- **地点**：${j.city || '未知'}　**经验**：${exp(j)}　**学历**：${j.education || '不限'}　**类型**：${j.recruitType}`)
  if (j.tags?.length) md.push(`- **标签**：${j.tags.join('、')}`)
  if (j.bossActive) md.push(`- **HR活跃**：${j.bossActive}`)
  if (j.sourceUrl) md.push(`- **链接**：${j.sourceUrl}`)
  md.push('')
  if (j.description) {
    md.push(j.description)
  } else {
    md.push('*(该岗位暂无JD详情正文)*')
  }
  md.push('')
})

fs.writeFileSync(path.join(outDir, `岗位库导出_${stamp}.md`), md.join('\n'))
fs.writeFileSync(path.join(outDir, `岗位库导出_${stamp}.json`), JSON.stringify(jobs, null, 2))

const withJd = jobs.filter(j => (j.description || '').length > 50).length
console.log(`已导出到 export/`)
console.log(`  岗位库导出_${stamp}.md   (${(fs.statSync(path.join(outDir, `岗位库导出_${stamp}.md`)).size / 1024).toFixed(0)} KB)`)
console.log(`  岗位库导出_${stamp}.json (${(fs.statSync(path.join(outDir, `岗位库导出_${stamp}.json`)).size / 1024).toFixed(0)} KB)`)
console.log(`统计: 总岗位 ${jobs.length}，含JD全文 ${withJd}`)
