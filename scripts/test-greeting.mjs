/* 打招呼文案离线自测：配置归一化 + 模板渲染边界（不依赖 DB / 网络） */
import { DEFAULT_GREETING, DEFAULT_GREETING_TEMPLATE, GREETING_PLACEHOLDERS, normalizeGreeting, renderGreeting } from '../greeting.js'

let pass = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) pass++
  else fails.push(`${name}${extra ? ` — ${extra}` : ''}`)
}

const JOB = {
  title: 'AI 产品经理', company: '深圳某科技', city: '深圳',
  salaryText: '20-35K·14薪', tags: ['AI', 'C端', '大模型', '第四个'],
}

/* ---------- 归一化 ---------- */
const n1 = normalizeGreeting({})
ok('空配置回落默认模板', n1.template === DEFAULT_GREETING_TEMPLATE)
ok('空配置布尔默认', n1.autoCopy === true && n1.openPage === true && n1.preview === false)
ok('空配置状态默认已打招呼', n1.markStatus === '已打招呼')
ok('非法 markStatus 回落', normalizeGreeting({ markStatus: '瞎写' }).markStatus === '已打招呼')
ok('markStatus 允许不修改', normalizeGreeting({ markStatus: '不修改' }).markStatus === '不修改')
ok('template 空白回落默认', normalizeGreeting({ template: '   ' }).template === DEFAULT_GREETING_TEMPLATE)
ok('超长模板截断到 1000', normalizeGreeting({ template: 'a'.repeat(2000) }).template.length === 1000)
ok('name 截断到 40', normalizeGreeting({ name: 'x'.repeat(100) }).name.length === 40)
ok('highlight 截断到 300', normalizeGreeting({ highlight: 'x'.repeat(500) }).highlight.length === 300)
ok('显式 false 被保留', normalizeGreeting({ autoCopy: false }).autoCopy === false)
ok('非布尔值回落默认', normalizeGreeting({ openPage: 'yes' }).openPage === true)
ok('null 输入不炸', normalizeGreeting(null).markStatus === '已打招呼')
ok('占位符清单非空且含 job', GREETING_PLACEHOLDERS.some(p => p.key === '{job}'))

/* ---------- 渲染 ---------- */
const cfg = normalizeGreeting({ name: '张三', years: '近2年', highlight: '主导过系统级音频产品' })
const text = renderGreeting(cfg, JOB)
ok('渲染含称呼', text.includes('张三'), text)
ok('渲染含年限说法', text.includes('近2年'))
ok('渲染含岗位名', text.includes('AI 产品经理'))
ok('渲染含公司名', text.includes('深圳某科技'))
ok('渲染含亮点', text.includes('主导过系统级音频产品'))
ok('渲染后无残留占位符', !/\{[a-zA-Z]+\}/.test(text), text)

const noCompany = renderGreeting(cfg, { title: '产品经理', company: '' })
ok('公司为空不留空引号', !noCompany.includes('「」'), noCompany)
ok('公司为空不留空括号', !/[（(]\s*[）)]/.test(noCompany), noCompany)

const bare = renderGreeting({ template: '{job}{company}{city}', name: '' }, { title: 'PM' })
ok('全空字段不产生空行', bare === 'PM', JSON.stringify(bare))

const tagsText = renderGreeting({ template: '{tags}' }, JOB)
ok('标签最多 3 个', tagsText === 'AI、C端、大模型', tagsText)

const salaryFallback = renderGreeting({ template: '{salary}' }, { salaryMin: 15, salaryMax: 25 })
ok('无 salaryText 时用数值区间', salaryFallback === '15-25K', salaryFallback)
const salaryOnlyMin = renderGreeting({ template: '{salary}' }, { salaryMin: 20 })
ok('只有下限给「起」', salaryOnlyMin === '20K 起', salaryOnlyMin)

const unknown = renderGreeting({ template: '你好{unknown}，看{job}' }, { title: 'PM' })
ok('未知占位符被清除', unknown === '你好，看PM', unknown)

const punctuation = renderGreeting({ template: '你好，。看{job}，' }, { title: 'PM' })
ok('重复/悬空标点被清理', punctuation === '你好。看PM', punctuation)

ok('空模板+空岗位仍有兜底文案', renderGreeting({ template: '{x}' }, {}).length > 0)
ok('渲染结果长度收敛在 1000 内', renderGreeting({ template: '{name}'.repeat(300), name: '好' }, JOB).length <= 1000)

const multiline = renderGreeting({ template: '第一行\n\n\n第二行' }, JOB)
ok('连续空行合并', multiline === '第一行\n第二行', JSON.stringify(multiline))

/* ---------- 空值残句（真实接口实测暴露过「您好，我是，产品经验」） ---------- */
const bothEmpty = renderGreeting({ name: '', years: '', highlight: '' }, JOB)
ok('称呼为空不留「我是，」', !/我是[，,、]/.test(bothEmpty) && !bothEmpty.includes('我是'), bothEmpty)
ok('年限为空不留「，产品经验」', !/产品经验/.test(bothEmpty), bothEmpty)
ok('空值清理后句子仍然通顺', bothEmpty.includes('您好') && bothEmpty.includes('AI 产品经理'), bothEmpty)

const onlyName = renderGreeting({ name: '张三', years: '' }, JOB)
ok('只有称呼：无「产品经验」残句', !/产品经验/.test(onlyName) && onlyName.includes('我是张三'), onlyName)

const onlyYears = renderGreeting({ name: '', years: '近2年' }, JOB)
ok('只有年限：无空称呼', !/我是[，,]/.test(onlyYears) && onlyYears.includes('近2年产品经验'), onlyYears)

const emptyJob = renderGreeting({ name: '张三', years: '近2年' }, {})
ok('岗位字段全空不产生空引号', !/[「【(（]\s*[」】)）]/.test(emptyJob), emptyJob)

console.log(fails.length ? '❌ 失败用例：\n' + fails.map(f => ' - ' + f).join('\n') : '✅ 全部通过')
console.log(`\n${pass} passed, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
