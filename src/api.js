export async function api(path, opts = {}) {
  const { body, ...rest } = opts
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...rest,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data = {}
  try { data = await res.json() } catch {}
  if (!res.ok || (data && data.ok === false)) {
    throw new Error(data?.error || `请求失败（${res.status}）`)
  }
  return data
}

export function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return String(iso).slice(0, 10)
  const now = new Date()
  const diff = (now - d) / 86400000
  if (diff >= 0 && diff < 1) return '今天'
  if (diff >= 1 && diff < 2) return '昨天'
  if (diff < 7) return `${Math.floor(diff)}天前`
  return `${d.getMonth() + 1}-${d.getDate()}`
}

export function fmtSalary(job) {
  if (job.salaryText) return job.salaryText
  if (job.salaryMin && job.salaryMax) return `${job.salaryMin}-${job.salaryMax}K`
  if (job.salaryMin) return `${job.salaryMin}K起`
  return '薪资面议'
}

export function expLabel(job) {
  if (job.experienceText) return job.experienceText
  if (job.recruitType === '校招') return '应届/校招'
  if (job.expMax === 99) return '经验不限'
  if (job.expMin && job.expMax && job.expMax !== 99) return `${job.expMin}-${job.expMax}年`
  if (job.expMin) return `${job.expMin}年以上`
  return '经验不限'
}

export function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}
