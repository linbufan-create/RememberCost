// ============================================================
// dsh-ledger —— 记账内核（纯逻辑：不读文件、不发网络请求）
//
// 移植自 DeepSeek-Balance-Whale-Widget 的 lib/accounting.mjs（MIT），
// 保留其核心口径：
//   · 金额一律按 1e-8 的整数「单位」运算，避免 0.1+0.2 类浮点误差；
//   · 按「北京时间自然日」归档：余额下降记为消费，上升记为到账，
//     到账不会冲掉已经观测到的消费（充值后数字不会变小）；
//   · 按账户指纹分本（换 API key / 换账号 = 换一本账），不同本不相加；
//   · 首次观测即统计起点；起点距当日 00:00、或末日最后一次观测距次日
//     00:00 超过 10 分钟，就标记为 partialDay —— 不把不完整说成完整；
//   · 校正（reconcile）是显式的：以「起点余额 + 累计到账 − 其它扣减 −
//     当前余额」反推本区间消费，带 revision 乐观锁，保留最近 50 次日志。
//
// 与来源的差别：
//   · 不做逐轮 token 估算（那是花费统计插件的职责），只保留余额观测口径；
//   · 增加按记账本的单日/区间读数，供设置页看板使用；
//   · 本模块始终只修改调用方持有的 ledger 对象，落盘由宿主负责。
// ============================================================

export const ACCOUNTING_VERSION = 1

/** 1 元 = 1e8 单位：DeepSeek 余额最多 6 位小数，留两位余量给换算。 */
const SCALE = 100000000

/** 观测缺口阈值：正常运行时单次缺口只有一两个观测周期，远小于 10 分钟。 */
const PARTIAL_GAP_MS = 10 * 60 * 1000

// ------------------------------------------------------------
// 定点金额
// ------------------------------------------------------------

export function moneyUnits(value) {
  const n = Number(value)
  const units = Math.round(n * SCALE)
  if (!Number.isFinite(n) || !Number.isSafeInteger(units)) throw new Error('金额无效或超出可记账范围')
  return units
}

export function preciseMoney(value) {
  return moneyUnits(value) / SCALE
}

export function addMoney(a, b) {
  return sumMoney([a, b])
}

export function sumMoney(values) {
  let units = 0
  for (const value of values) units += moneyUnits(value)
  if (!Number.isSafeInteger(units)) throw new Error('金额合计超出可记账范围')
  return units / SCALE
}

// ------------------------------------------------------------
// 北京时间自然日
// ------------------------------------------------------------

export function beijingDay(time = Date.now()) {
  const d = new Date(Number(time) + 8 * 3600000)
  if (!Number.isFinite(d.getTime())) throw new Error('无效的观测时间')
  return d.toISOString().slice(0, 10)
}

export function dayOffset(day, offset) {
  return beijingDay(Date.parse(day + 'T00:00:00+08:00') + offset * 86400000)
}

/** 0=周日 … 6=周六（北京时间）。看板用它给日期排星期。 */
export function weekdayOf(day) {
  const t = Date.parse(String(day) + 'T00:00:00+08:00')
  if (!Number.isFinite(t)) return null
  return new Date(t + 8 * 3600000).getUTCDay()
}

function partialDayOf(day, row, now) {
  try {
    const start = Date.parse(String(day) + 'T00:00:00+08:00')
    if (!Number.isFinite(start)) return true
    const end = start + 86400000
    const first = Number(row && row.firstAt)
    const last = Number(row && row.lastAt)
    if (!Number.isFinite(first) || !Number.isFinite(last)) return true
    const beforeGap = first - start
    const afterGap = Number(now) >= end ? (end - last) : 0
    return beforeGap > PARTIAL_GAP_MS || afterGap > PARTIAL_GAP_MS
  } catch (err) {
    return true
  }
}

/**
 * 给界面用的观测完整度：缺口在起点还是末尾、从几点开始有观测。
 */
export function partialDayInfo(day, row, now = Date.now()) {
  const start = Date.parse(String(day) + 'T00:00:00+08:00')
  const partialDay = partialDayOf(day, row, now)
  const first = Number(row && row.firstAt)
  const last = Number(row && row.lastAt)
  return {
    partialDay,
    observedFromMs: Number.isFinite(first) ? first : null,
    observedToMs: Number.isFinite(last) ? last : null,
    leadingGapMs: Number.isFinite(first) && Number.isFinite(start) ? Math.max(0, first - start) : null,
    trailingGapMs: Number.isFinite(last) && Number.isFinite(start) && now >= start + 86400000
      ? Math.max(0, start + 86400000 - last)
      : 0,
  }
}

// ------------------------------------------------------------
// 记账本
// ------------------------------------------------------------

function currentScope(ledger) {
  const a = ledger && ledger.accounting
  return a && a.version === ACCOUNTING_VERSION ? String(a.active || '') : ''
}

/** 所有记账本：当前本排最前，其余按最近观测倒序。 */
export function booksOf(ledger) {
  const a = ledger && ledger.accounting
  if (!a || a.version !== ACCOUNTING_VERSION || !a.books) return []
  const out = []
  for (const scope of Object.keys(a.books)) {
    const book = a.books[scope]
    if (!book || !book.days) continue
    out.push({ scope, book, active: scope === a.active, lastAt: Number(book.lastAt) || 0 })
  }
  return out.sort((x, y) => (x.active === y.active ? (y.lastAt - x.lastAt) : (x.active ? -1 : 1)))
}

/** 全部记账本的日期并集（用于判断「还有没有更早的账」）。 */
export function accountingDays(ledger) {
  const set = new Set()
  for (const { book } of booksOf(ledger)) for (const d of Object.keys(book.days || {})) set.add(d)
  return Array.from(set).sort()
}

/** 某一天在各记账本里的明细：当前本排最前，其余按最近观测倒序。 */
export function bookBreakdown(ledger, day) {
  const rows = []
  for (const { scope, book, active, lastAt } of booksOf(ledger)) {
    const row = book.days[day]
    if (!row) continue
    rows.push({
      scope,
      currency: String(book.currency || 'CNY').toUpperCase(),
      active,
      lastAt,
      amount: preciseMoney(observedAmount(row)),
      firstObservedAt: row.firstAt,
      lastObservedAt: row.lastAt,
      needsReview: row.creditUnits > (row.correction ? row.correction.creditUnits : 0),
    })
  }
  return rows
}

function observedAmount(row) {
  const c = row.correction
  return (c ? c.amountUnits + row.debitUnits - c.debitUnits : row.debitUnits) / SCALE
}

/**
 * 余额接口除了总额，还会给「充值余额」与「赠金余额」两个分量。
 * 分开看这两个钱包，就能把「充值」与「消费」从同一次总额变化里拆开：
 * 任一钱包增加 = 到账，总额的其余下降 = 消费。
 */
function componentUnits(snapshot) {
  const top = snapshot.toppedUp === null || snapshot.toppedUp === undefined ? null : moneyUnits(snapshot.toppedUp)
  const bonus = snapshot.bonus === null || snapshot.bonus === undefined ? null : moneyUnits(snapshot.bonus)
  return { top, bonus }
}

/** 分量之和与总额的允许误差（1e-5 元），只用来挡明显不一致的载荷。 */
const COMPONENT_TOLERANCE_UNITS = 1000

function explainedCredits(row, correction, verifiedUnits) {
  const correctionCredits = correction ? Number(correction.creditUnits) || 0 : 0
  // 老版本校正没有 verifiedCreditUnits：按「当时已识别的不超过校正到账」保守处理，
  // 避免把已校正过的到账重复解释一遍。
  const correctionVerified = correction
    ? (Number.isFinite(Number(correction.verifiedCreditUnits))
      ? Number(correction.verifiedCreditUnits)
      : Math.min(verifiedUnits, correctionCredits))
    : 0
  return correctionCredits + Math.max(0, verifiedUnits - correctionVerified)
}

function revisionOf(scope, day, row) {
  return [scope, day, row.firstAt, row.lastUnits, row.debitUnits, row.creditUnits, row.revision || 0].join(':')
}

/** 最近一次观测的余额（取 lastAt 最大的那天）。 */
function bookCurrentBalance(book) {
  let best = null
  for (const day of Object.keys(book.days || {})) {
    const row = book.days[day]
    if (!row) continue
    if (!best || Number(row.lastAt) > Number(best.lastAt)) best = row
  }
  return best ? best.lastUnits / SCALE : null
}

function rowSummary(scope, book, row, day) {
  const correction = row.correction
  const verifiedUnits = Number(row.verifiedCreditUnits) || 0
  const needsReview = row.creditUnits > explainedCredits(row, correction, verifiedUnits)
  const source = needsReview
    ? 'balance-needs-review'
    : (correction ? 'balance-corrected' : (verifiedUnits > 0 ? 'balance-observed-credited' : 'balance-observed'))
  return {
    day,
    amount: preciseMoney(observedAmount(row)),
    currency: String(book.currency || 'CNY').toUpperCase(),
    source,
    label: needsReview
      ? '已观测消费 · 待核对余额调整'
      : (correction ? '已校正消费' : (verifiedUnits > 0 ? '已观测消费 · 已识别到账' : '已观测消费')),
    firstObservedAt: row.firstAt,
    lastObservedAt: row.lastAt,
    openingBalance: row.openingUnits / SCALE,
    currentBalance: row.lastUnits / SCALE,
    observedDecrease: row.debitUnits / SCALE,
    observedIncrease: row.creditUnits / SCALE,
    identifiedIncrease: verifiedUnits / SCALE,
    needsReview,
    revision: revisionOf(scope, day, row),
    ...partialDayInfo(day, row),
    credits: correction ? correction.creditsUnits / SCALE : null,
    otherDebits: correction ? correction.otherDebitsUnits / SCALE : null,
    correctedAt: correction ? correction.at : null,
  }
}

/** 指定记账本某一天的读数；没有观测返回 null。 */
export function bookSummary(ledger, scope, day) {
  const a = ledger && ledger.accounting
  if (!a || a.version !== ACCOUNTING_VERSION || !a.books) return null
  const book = a.books[scope]
  const row = book && book.days ? book.days[day] : null
  if (!row) return null
  return rowSummary(scope, book, row, day)
}

/** 当前记账本某一天的读数（兼容来源的调用形状）。 */
export function balanceSummary(ledger, day = beijingDay()) {
  return bookSummary(ledger, currentScope(ledger), day)
}

/**
 * 记下一次余额观测。会修改调用方传入的 ledger。
 *
 * @param {object} ledger 账本对象
 * @param {{balance:number|string, toppedUp?:number|string|null, bonus?:number|string|null, currency?:string, scope?:string, at?:number}} snapshot
 * @returns {object} 当天的读数
 */
export function observeBalance(ledger, snapshot) {
  const at = Number(snapshot.at ?? Date.now())
  const day = beijingDay(at)
  const units = moneyUnits(snapshot.balance)
  const currency = String(snapshot.currency || 'CNY').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('余额币种无效')
  const scopeToken = String(snapshot.scope || 'default')
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(scopeToken)) throw new Error('账户标识无效')
  const scope = scopeToken + '-' + currency
  const components = componentUnits(snapshot)

  let a = ledger.accounting
  if (!a || a.version !== ACCOUNTING_VERSION) {
    // 旧账本没有可信的充值元数据：保留旧 history 供参考，开启新的观测窗口。
    a = ledger.accounting = {
      version: ACCOUNTING_VERSION,
      active: scope,
      books: {},
      migratedAt: at,
      legacyHistory: { ...(ledger.history || {}) },
    }
  }
  a.books ||= {}
  let book = a.books[scope]
  if (!book) book = a.books[scope] = { currency, days: {} }

  // 重复或乱序的样本（包括迟到的昨天样本）一律忽略：观测时间不能倒退。
  if (book.lastAt != null && at <= book.lastAt) return bookSummary(ledger, scope, ledger.date || day)

  a.active = scope

  let row = book.days[day]
  if (!row) {
    row = book.days[day] = {
      day,
      firstAt: at,
      lastAt: at,
      openingUnits: units,
      lastUnits: units,
      debitUnits: 0,
      creditUnits: 0,
      verifiedCreditUnits: 0,
      revision: 0,
      correction: null,
    }
  } else {
    const delta = row.lastUnits - units // >0 表示总额下降
    let debits = delta > 0 ? delta : 0
    let credits = delta < 0 ? -delta : 0
    let verified = 0

    // 有「充值钱包 / 赠金钱包」两个分量时，优先按钱包分别记：
    //   任一钱包增加 = 到账；总额的其余下降 = 消费。
    // 这样「充值和消费发生在同一个观测窗口」也能拆开（同一钱包内除外）。
    const previousTop = Number(book.lastTopUpUnits)
    const previousBonus = Number(book.lastBonusUnits)
    if (components.top !== null && components.bonus !== null
      && Number.isSafeInteger(previousTop) && Number.isSafeInteger(previousBonus)) {
      const sumUnits = components.top + components.bonus
      if (Number.isSafeInteger(sumUnits) && Math.abs(sumUnits - units) <= COMPONENT_TOLERANCE_UNITS) {
        const topDelta = components.top - previousTop
        const bonusDelta = components.bonus - previousBonus
        const creditDelta = Math.max(0, topDelta) + Math.max(0, bonusDelta)
        const debitDelta = delta + creditDelta
        if (Number.isSafeInteger(debitDelta) && debitDelta >= 0) {
          debits = debitDelta
          credits = creditDelta
          verified = creditDelta
        }
      }
    }

    if (debits > 0) row.debitUnits += debits
    if (credits > 0) {
      row.creditUnits += credits
      if (verified > 0) row.verifiedCreditUnits = (Number(row.verifiedCreditUnits) || 0) + verified
    }
    row.lastUnits = units
    row.lastAt = at
  }

  // 记下本次的钱包基线，供下一次拆账；两个分量齐全才更新，避免错位相减。
  if (components.top !== null && components.bonus !== null) {
    book.lastTopUpUnits = components.top
    book.lastBonusUnits = components.bonus
  }
  book.lastAt = at
  ledger.date = day

  // 兼容旧字段：来源插件的前端与老设置写入器读这些字段。
  ledger.dayStart = row.openingUnits / SCALE
  ledger.lastBalance = row.lastUnits / SCALE
  const summary = rowSummary(scope, book, row, day)
  ledger.todayUsage = summary.amount
  ledger.history ||= {}
  ledger.history[day] = summary.amount
  return summary
}

function adjustmentUnits(value, required = false) {
  if (value === '' || value === null || value === undefined) {
    if (required) throw new Error('请填写本统计区间的累计到账金额，未充值请填 0')
    return 0
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(value))) {
    throw new Error('金额须为非负数，最多保留 8 位小数')
  }
  const units = moneyUnits(value)
  if (units < 0) throw new Error('金额不能为负数')
  return units
}

/**
 * 校正某一天的消费。会修改调用方传入的 ledger。
 *
 * @param {object} ledger 账本对象
 * @param {{day:string, revision:string, action?:'correct'|'reset', credits?:string, otherDebits?:string, confirmed?:boolean}} input
 * @param {number} now
 * @returns {object} 校正后的当天读数
 */
export function reconcileBalance(ledger, input, now = Date.now()) {
  const day = String(input.day || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('请选择有效的记账日期')
  const scope = currentScope(ledger)
  const a = ledger && ledger.accounting
  const book = a && a.books ? a.books[scope] : null
  const row = book && book.days ? book.days[day] : null
  if (!row) throw new Error('这一天没有余额观测记录，无法校正')
  if (input.revision !== revisionOf(scope, day, row)) {
    const err = new Error('余额或校正记录已更新，请重新打开校正窗口后核对金额')
    err.status = 409
    throw err
  }
  if (input.action !== 'reset' && input.confirmed !== true) {
    throw new Error('请先确认已核对本统计区间的全部余额调整')
  }

  let correction = null
  if (input.action !== 'reset') {
    const creditsUnits = adjustmentUnits(input.credits, true)
    const otherDebitsUnits = adjustmentUnits(input.otherDebits)
    const amountUnits = row.openingUnits + creditsUnits - otherDebitsUnits - row.lastUnits
    if (!Number.isSafeInteger(amountUnits) || amountUnits < 0) {
      throw new Error('校正后消费为负或超出范围，请核对统计起点与累计到账金额')
    }
    correction = {
      at: Number(now),
      creditsUnits,
      otherDebitsUnits,
      amountUnits,
      debitUnits: row.debitUnits,
      creditUnits: row.creditUnits,
      // 校正时把「已经识别为到账」的金额一并记下，避免之后重复解释同一笔到账。
      verifiedCreditUnits: Number(row.verifiedCreditUnits) || 0,
    }
  }

  row.correctionLog ||= []
  row.correctionLog.push({ at: Number(now), previous: row.correction, next: correction })
  if (row.correctionLog.length > 50) row.correctionLog.splice(0, row.correctionLog.length - 50)
  row.correction = correction
  row.revision = (row.revision || 0) + 1

  const summary = rowSummary(scope, book, row, day)
  ledger.history ||= {}
  ledger.history[day] = summary.amount
  if (ledger.date === day) ledger.todayUsage = summary.amount
  return summary
}

// ------------------------------------------------------------
// 看板查询
// ------------------------------------------------------------

function publicBook(entry) {
  const days = Object.keys(entry.book.days || {}).sort()
  return {
    scope: entry.scope,
    active: entry.active,
    currency: String(entry.book.currency || 'CNY').toUpperCase(),
    lastAt: entry.lastAt,
    dayCount: days.length,
    firstDay: days[0] || null,
    lastDay: days[days.length - 1] || null,
    currentBalance: bookCurrentBalance(entry.book),
  }
}

/**
 * 看板数据：指定区间内的逐日读数、区间合计、当前余额与账本清单。
 *
 * options:
 *   days   区间天数（1..1095；0/缺省 = 全部）
 *   scope  指定记账本（缺省 = 当前本）
 *   now    计算用的「现在」（测试可注入）
 */
export function ledgerOverview(ledger, options = {}) {
  const now = Number(options.now)
  const at = Number.isFinite(now) ? now : Date.now()
  const today = beijingDay(at)
  const books = booksOf(ledger).map(publicBook)
  const activeScope = currentScope(ledger)
  const wanted = options.scope ? String(options.scope) : ''
  const selected = books.find((b) => b.scope === wanted)
    || books.find((b) => b.scope === activeScope)
    || books[0]
    || null
  const scope = selected ? selected.scope : activeScope
  const currency = selected ? selected.currency : 'CNY'

  const span = Math.round(Number(options.days))
  let from
  if (span > 0) {
    const n = Math.min(Math.max(span, 1), 1095)
    from = dayOffset(today, -(n - 1))
  } else {
    from = selected && selected.firstDay ? selected.firstDay : today
    if (from > today) from = today
  }

  const rows = []
  for (let day = from; day <= today; day = dayOffset(day, 1)) {
    const summary = bookSummary(ledger, scope, day)
    if (summary) {
      rows.push({ ...summary, observed: true, weekday: weekdayOf(day) })
    } else {
      rows.push({
        day,
        amount: 0,
        currency,
        observed: false,
        partialDay: true,
        weekday: weekdayOf(day),
        needsReview: false,
      })
    }
  }

  const observedRows = rows.filter((r) => r.observed)
  const total = sumMoney(observedRows.map((r) => r.amount))
  const monthFrom = today.slice(0, 8) + '01'
  const monthAmounts = []
  for (let day = monthFrom; day <= today; day = dayOffset(day, 1)) {
    const summary = bookSummary(ledger, scope, day)
    if (summary) monthAmounts.push(summary.amount)
  }
  const monthTotal = sumMoney(monthAmounts)
  const averageRaw = observedRows.length ? total / observedRows.length : 0

  return {
    today,
    from,
    to: today,
    scope,
    currency,
    active: scope === activeScope,
    days: rows,
    todaySummary: bookSummary(ledger, scope, today),
    totals: {
      amount: total,
      count: observedRows.length,
      month: monthTotal,
      average: Math.round(averageRaw * SCALE) / SCALE,
    },
    currentBalance: selected ? selected.currentBalance : null,
    lastObservedAt: selected ? selected.lastAt || null : null,
    books,
  }
}
