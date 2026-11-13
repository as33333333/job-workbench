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
    const err = new Error(data?.error || `请求失败（${res.status}）`)
    err.status = res.status
    throw err
  }
  return data
}

/* 流式接口（SSE over POST）：onProgress 收到 {message, percent}，返回 done 事件的负载
 * 旧版服务端（如 8787 上未重启的进程）没有 /stream 路由，会 404 → 自动回退到普通接口，只是没有进度 */
export async function apiStream(path, body, { onProgress, signal, fallbackPath, fallbackBody } = {}) {
  const res = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body || {}),
    signal,
  })

  const canFallback = fallbackPath && [404, 405, 501].includes(res.status)
  if (canFallback) {
    onProgress?.({ message: '服务端为旧版本，正在用兼容模式分析（无进度）…', percent: null })
    return api(fallbackPath, { method: 'POST', body: fallbackBody || body })
  }
  if (!res.ok || !res.body) {
    let data = {}
    try { data = await res.json() } catch {}
    throw new Error(data?.error || `请求失败（${res.status}）`)
  }

  const type = res.headers.get('content-type') || ''
  if (!type.includes('text/event-stream')) {
    // 兼容非流式响应（代理或旧服务端直接返回 JSON）
    const data = await res.json().catch(() => ({}))
    if (data && data.ok === false) throw new Error(data.error || '分析失败')
    if (data && (data.data || data.id)) return data
    throw new Error(data?.error || '服务端返回了非预期内容，请重试')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result = null
  let failure = ''
  const handle = (chunk) => {
    let event = 'message'
    const dataLines = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    let payload = null
    try { payload = dataLines.length ? JSON.parse(dataLines.join('')) : null } catch { payload = null }
    if (event === 'progress') onProgress?.({ message: payload?.message || '', percent: payload?.percent ?? null })
    else if (event === 'done') result = payload
    else if (event === 'error') failure = payload?.error || '分析失败'
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      handle(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 2)
    }
  }
  if (buffer.trim()) handle(buffer)
  if (failure) throw new Error(failure)
  if (!result) throw new Error('与服务端的连接中断，未收到分析结果，请重试')
  return result
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
