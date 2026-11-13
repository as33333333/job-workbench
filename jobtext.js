/* JD 文本工具：清理页面噪声、判断正文是否完整（服务端与脚本共用） */

const CUT_MARKERS = ['竞争力分析', '相似职位', '推荐职位', '为你推荐', '看过该职位的人还看了']

const DROP_PATTERNS = [
  /^认证资质/, /^人力资源服务许可证/, /^劳务派遣经营许可证/, /^营业执照/,
  /^举报$/, /^投诉$/, /^抖音号/, /^微信公众号/, /^扫码/, /^下载APP/,
]

export function stripJdNoise(text) {
  let t = String(text || '').replace(/\r\n/g, '\n')
  for (const marker of CUT_MARKERS) {
    const i = t.indexOf(marker)
    if (i > 60) t = t.slice(0, i)
  }
  return t.split('\n')
    .filter(line => {
      const l = line.trim()
      return !l || !DROP_PATTERNS.some(re => re.test(l))
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 判断 JD 是否"正文不全"。不只看字数：有些 JD 本身精炼、没有"岗位职责/任职要求"小标题，
 * 但只要有成段的职责/能力描述就属于完整；只有福利标签或职位名字的才算缺失。
 */
export function jdLooksIncomplete(job) {
  const raw = String(job?.description || '').trim()
  // 去掉采集时拼在前面的 【福利】 行，只判断正文
  const body = raw.replace(/^【福利】[^\n]*\n*/g, '').trim()
  if (body.length < 60) return true

  const hasDuty = /(岗位职责|工作职责|职位描述|职位详情|工作内容|你将负责|岗位内容|职责描述)/.test(body)
  const hasReq = /(任职要求|岗位要求|任职资格|职位要求|我们希望|能力要求|加分项)/.test(body)
  if (hasDuty || hasReq) return false

  // 无小标题但有条目化描述
  const items = (body.match(/(^|\n)\s*(\d+[.、)]|[-•·])\s*/g) || []).length
  if (body.length >= 300 && items >= 2) return false
  // 成段职责/能力描述
  if (body.length >= 200 && /(负责|要求|能力|经验|熟悉|掌握|推动|设计)/.test(body)) return false
  return body.length < 160
}
