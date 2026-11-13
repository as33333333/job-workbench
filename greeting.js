/* 打招呼文案：配置归一化 + 模板渲染（纯函数，不依赖 DB，便于离线测试）
 * 占位符只做「有值就填、没值就清」的字符串替换，不臆造任何经历或数字。 */

export const GREETING_PLACEHOLDERS = [
  { key: '{name}', label: '我的称呼', from: '配置' },
  { key: '{years}', label: '经验年限说法（如「近2年」）', from: '配置' },
  { key: '{highlight}', label: '一句话亮点', from: '配置' },
  { key: '{job}', label: '岗位名称', from: '岗位' },
  { key: '{company}', label: '公司名称', from: '岗位' },
  { key: '{city}', label: '城市', from: '岗位' },
  { key: '{salary}', label: '薪资范围', from: '岗位' },
  { key: '{tags}', label: '岗位标签（最多 3 个）', from: '岗位' },
]

export const DEFAULT_GREETING_TEMPLATE = [
  '您好，我是{name}，{years}产品经验，看到「{company}」在招「{job}」，和我的方向比较契合。',
  '{highlight}',
  '想和您沟通一下岗位情况，方便的话回复我，谢谢！',
].join('\n')

export const DEFAULT_GREETING = {
  name: '',
  years: '',
  highlight: '',
  template: DEFAULT_GREETING_TEMPLATE,
  autoCopy: true,
  openPage: true,
  preview: false,
  markStatus: '已打招呼',
}

export const GREETING_MARK_OPTIONS = ['已打招呼', '待投递', '不修改']

const MAX_TEMPLATE = 1000
const text = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback)

/* 配置归一化：字段类型/长度/枚举全部夹紧，坏数据不会写进 DB 也不会抛错 */
export function normalizeGreeting(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt)
  const template = text(src.template).slice(0, MAX_TEMPLATE)
  return {
    name: text(src.name).slice(0, 40),
    years: text(src.years).slice(0, 40),
    highlight: text(src.highlight).slice(0, 300),
    template: template || DEFAULT_GREETING_TEMPLATE,
    autoCopy: bool(src.autoCopy, DEFAULT_GREETING.autoCopy),
    openPage: bool(src.openPage, DEFAULT_GREETING.openPage),
    preview: bool(src.preview, DEFAULT_GREETING.preview),
    markStatus: GREETING_MARK_OPTIONS.includes(src.markStatus) ? src.markStatus : DEFAULT_GREETING.markStatus,
  }
}

const salaryOf = (job) => {
  if (job.salaryText) return String(job.salaryText).trim()
  const { salaryMin, salaryMax } = job
  if (salaryMin && salaryMax) return `${salaryMin}-${salaryMax}K`
  if (salaryMin) return `${salaryMin}K 起`
  return ''
}

const valuesOf = (config, job) => ({
  '{name}': config.name,
  '{years}': config.years,
  '{highlight}': config.highlight,
  '{job}': String(job?.title || '').trim(),
  '{company}': String(job?.company || '').trim(),
  '{city}': String(job?.city || '').trim(),
  '{salary}': salaryOf(job || {}),
  '{tags}': (Array.isArray(job?.tags) ? job.tags : []).slice(0, 3).join('、'),
})

/* 清理占位符落空后留下的空壳：空引号、空括号、重复标点、空行 */
function tidy(s) {
  return String(s)
    .replace(/([「『（(【])\s*([」』）)】])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([，,、；;])\s*([，,。；;])/g, '$2')
    .replace(/[，,]\s*。/g, '。')
    .replace(/。{2,}/g, '。')
    .replace(/^[，。、；;：:\s]+/gm, '')
    .replace(/[，、；;：:]\s*$/gm, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/* 空值残句清理：模板里「我是{name}」「{years}产品经验」这类句式在字段为空时会剩下「我是，」 */
function dropEmptyClause(s, emptyKeys) {
  let out = s
  if (emptyKeys.has('{name}')) out = out.replace(/我是[ \t]*[，,、]?[ \t]*/g, '')
  if (emptyKeys.has('{years}')) out = out.replace(/[，,、]?[ \t]*产品经验[ \t]*[，,、]?/g, '，')
  return out
}

export function renderGreeting(config, job) {
  const cfg = normalizeGreeting(config)
  const map = valuesOf(cfg, job)
  const emptyKeys = new Set(Object.keys(map).filter(key => !map[key]))
  let out = cfg.template
  for (const [key, value] of Object.entries(map)) {
    out = out.split(key).join(value || '')
  }
  // 未知占位符原样保留会让文案看起来像模板，直接去掉
  out = out.replace(/\{[a-zA-Z]+\}/g, '')
  const result = tidy(dropEmptyClause(out, emptyKeys)).slice(0, MAX_TEMPLATE)
  if (result) return result
  const fallback = `您好，想了解一下「${map['{job}']}」这个岗位，方便沟通吗？`
  return tidy(fallback)
}
