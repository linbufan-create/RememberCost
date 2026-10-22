// ============================================================
// dsh-ledger 记账内核单测（纯 node，无外部依赖）
// 运行：node test/accounting.test.mjs
// ============================================================

import assert from 'node:assert/strict'

import {
  ACCOUNTING_VERSION,
  addMoney,
  balanceSummary,
  beijingDay,
  bookSummary,
  dayOffset,
  ledgerOverview,
  moneyUnits,
  observeBalance,
  preciseMoney,
  reconcileBalance,
  sumMoney,
} from '../accounting.mjs'

const DAY = 86400000
const t0 = Date.parse('2026-10-22T01:00:00+08:00')

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log('ok - ' + name)
}

test('定点金额：0.1 + 0.2 === 0.3', () => {
  assert.equal(addMoney(0.1, 0.2), 0.3)
  assert.equal(sumMoney([0.1, 0.2, 0.3]), 0.6)
  assert.equal(preciseMoney('1.23456789'), 1.23456789)
  assert.throws(() => moneyUnits('abc'))
})

test('北京时间自然日', () => {
  assert.equal(beijingDay(Date.parse('2026-10-21T16:30:00Z')), '2026-10-22')
  assert.equal(beijingDay(Date.parse('2026-10-21T15:59:00Z')), '2026-10-21')
  assert.equal(dayOffset('2026-03-01', 1), '2026-03-02')
  assert.equal(dayOffset('2026-01-01', -1), '2025-12-31')
})

test('余额下降累计为消费，上升单独记录且不冲掉消费', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, currency: 'CNY', scope: 'acct', at: t0 })
  let s = observeBalance(ledger, { balance: 98.5, currency: 'CNY', scope: 'acct', at: t0 + 60000 })
  assert.equal(s.amount, 1.5)
  s = observeBalance(ledger, { balance: 99, currency: 'CNY', scope: 'acct', at: t0 + 120000 })
  assert.equal(s.amount, 1.5)
  assert.equal(s.observedIncrease, 0.5)
  assert.equal(s.needsReview, true)
  s = observeBalance(ledger, { balance: 97, currency: 'CNY', scope: 'acct', at: t0 + 180000 })
  assert.equal(s.amount, 3.5)
  assert.equal(s.openingBalance, 100)
  assert.equal(s.currentBalance, 97)
  assert.equal(s.observedDecrease, 3.5)
  assert.equal(s.observedIncrease, 0.5)
  assert.equal(s.label, '已观测消费 · 待核对余额调整')
  assert.equal(ledger.todayUsage, 3.5)
  assert.equal(ledger.accounting.version, ACCOUNTING_VERSION)
})

test('重复或乱序的余额样本被忽略', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, currency: 'CNY', scope: 'acct', at: t0 })
  observeBalance(ledger, { balance: 97, currency: 'CNY', scope: 'acct', at: t0 + 180000 })
  const s = observeBalance(ledger, { balance: 90, currency: 'CNY', scope: 'acct', at: t0 + 60000 })
  assert.equal(s.currentBalance, 97)
  assert.equal(s.amount, 3)
})

test('钱包分量：赠金消费自动从总额里拆出', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 16.28, toppedUp: 14.14, bonus: 2.14, currency: 'CNY', scope: 'acct', at: t0 })
  const s = observeBalance(ledger, { balance: 15.40, toppedUp: 14.14, bonus: 1.26, currency: 'CNY', scope: 'acct', at: t0 + 60000 })
  assert.equal(s.amount, 0.88)
  assert.equal(s.observedIncrease, 0)
  assert.equal(s.identifiedIncrease, 0)
  assert.equal(s.needsReview, false)
  assert.equal(s.label, '已观测消费')
})

test('钱包分量：充值 20 与赠金消费 5 发生在同一观测窗口', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, toppedUp: 90, bonus: 10, currency: 'CNY', scope: 'acct', at: t0 })
  const s = observeBalance(ledger, { balance: 115, toppedUp: 110, bonus: 5, currency: 'CNY', scope: 'acct', at: t0 + 60000 })
  assert.equal(s.observedIncrease, 20)
  assert.equal(s.identifiedIncrease, 20)
  assert.equal(s.amount, 5)
  assert.equal(s.needsReview, false)
  assert.equal(s.label, '已观测消费 · 已识别到账')
})

test('钱包分量：充值后继续消费，到账不会被算成消费', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, toppedUp: 0, bonus: 100, currency: 'CNY', scope: 'acct', at: t0 })
  let s = observeBalance(ledger, { balance: 140, toppedUp: 50, bonus: 90, currency: 'CNY', scope: 'acct', at: t0 + 60000 })
  assert.equal(s.amount, 10)
  assert.equal(s.identifiedIncrease, 50)
  s = observeBalance(ledger, { balance: 120, toppedUp: 50, bonus: 70, currency: 'CNY', scope: 'acct', at: t0 + 120000 })
  assert.equal(s.amount, 30)
  assert.equal(s.observedIncrease, 50)
  assert.equal(s.needsReview, false)
})

test('分量缺失：退回总额口径，上升进入待核对；校正后不再重复提示', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, toppedUp: 100, bonus: 0, currency: 'CNY', scope: 'acct', at: t0 })
  let s = observeBalance(ledger, { balance: 120, currency: 'CNY', scope: 'acct', at: t0 + 60000 })
  assert.equal(s.observedIncrease, 20)
  assert.equal(s.identifiedIncrease, 0)
  assert.equal(s.needsReview, true)

  s = reconcileBalance(ledger, {
    day: '2026-10-22', revision: s.revision, action: 'correct', credits: '20', confirmed: true,
  }, t0 + 120000)
  assert.equal(s.amount, 0)
  assert.equal(s.needsReview, false)
  const row = ledger.accounting.books['acct-CNY'].days['2026-10-22']
  assert.equal(row.correction.verifiedCreditUnits, 0)

  s = observeBalance(ledger, { balance: 125, currency: 'CNY', scope: 'acct', at: t0 + 180000 })
  assert.equal(s.observedIncrease, 25)
  assert.equal(s.needsReview, true)

  s = reconcileBalance(ledger, {
    day: '2026-10-22', revision: s.revision, action: 'correct', credits: '25', confirmed: true,
  }, t0 + 240000)
  assert.equal(s.needsReview, false)
})

test('partialDay：起点缺口超过 10 分钟才算部分数据', () => {
  const early = {}
  observeBalance(early, { balance: 100, currency: 'CNY', scope: 'a', at: Date.parse('2026-10-22T00:01:00+08:00') })
  assert.equal(early.accounting.books['a-CNY'].days['2026-10-22'].firstAt, Date.parse('2026-10-22T00:01:00+08:00'))
  assert.equal(balanceSummary(early, '2026-10-22').partialDay, false)

  const late = {}
  observeBalance(late, { balance: 100, currency: 'CNY', scope: 'a', at: t0 })
  const info = balanceSummary(late, '2026-10-22')
  assert.equal(info.partialDay, true)
  assert.equal(info.leadingGapMs, 3600000)
  assert.equal(info.trailingGapMs, 0)
})

test('已经过去的日子：末日观测离次日 00:00 太远 = 部分数据', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, currency: 'CNY', scope: 'a', at: Date.parse('2026-10-20T22:30:00+08:00') })
  observeBalance(ledger, { balance: 99, currency: 'CNY', scope: 'a', at: Date.parse('2026-10-21T01:00:00+08:00') })
  const info = bookSummary(ledger, 'a-CNY', '2026-10-20')
  assert.equal(info.partialDay, true)
  assert.equal(info.trailingGapMs, 5400000)
})

test('余额校正：按起点 + 到账 − 其它扣减 − 当前余额反推', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, currency: 'CNY', scope: 'acct', at: t0 })
  const before = observeBalance(ledger, { balance: 97, currency: 'CNY', scope: 'acct', at: t0 + 180000 })
  const done = reconcileBalance(ledger, {
    day: '2026-10-22',
    revision: before.revision,
    action: 'correct',
    credits: '10',
    otherDebits: '0',
    confirmed: true,
  }, t0 + 240000)
  assert.equal(done.amount, 13)
  assert.equal(done.label, '已校正消费')
  assert.equal(done.needsReview, false)
  assert.equal(done.credits, 10)
  assert.equal(done.otherDebits, 0)
  assert.equal(ledger.todayUsage, 13)
  assert.equal(ledger.accounting.books['acct-CNY'].days['2026-10-22'].correctionLog.length, 1)
})

test('校正失败：revision 过期要抛 409，负金额要拒绝', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, currency: 'CNY', scope: 'acct', at: t0 })
  const before = observeBalance(ledger, { balance: 97, currency: 'CNY', scope: 'acct', at: t0 + 180000 })
  assert.throws(() => reconcileBalance(ledger, {
    day: '2026-10-22',
    revision: before.revision + ':stale',
    action: 'correct',
    credits: '1',
    confirmed: true,
  }), (err) => err && err.status === 409)
  assert.throws(() => reconcileBalance(ledger, {
    day: '2026-10-22',
    revision: before.revision,
    action: 'correct',
    credits: '-1',
    confirmed: true,
  }), /金额须为非负数/)
  assert.throws(() => reconcileBalance(ledger, {
    day: '2026-10-22',
    revision: before.revision,
    action: 'correct',
    credits: '1',
    confirmed: false,
  }), /请先确认/)
})

test('reset 校正：回到纯观测口径', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, currency: 'CNY', scope: 'acct', at: t0 })
  let summary = observeBalance(ledger, { balance: 97, currency: 'CNY', scope: 'acct', at: t0 + 180000 })
  summary = reconcileBalance(ledger, {
    day: '2026-10-22', revision: summary.revision, action: 'correct', credits: '10', confirmed: true,
  }, t0 + 240000)
  const reset = reconcileBalance(ledger, {
    day: '2026-10-22', revision: summary.revision, action: 'reset',
  }, t0 + 300000)
  assert.equal(reset.amount, 3)
  assert.equal(reset.label, '已观测消费')
})

test('按账户分本：不同 scope 互不相加，active 跟随最近观测', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, currency: 'CNY', scope: 'keyA', at: t0 })
  observeBalance(ledger, { balance: 50, currency: 'CNY', scope: 'keyB', at: t0 + 60000 })
  const overview = ledgerOverview(ledger, { days: 7, now: t0 + 3600000 })
  assert.equal(overview.books.length, 2)
  assert.equal(overview.books[0].active, true)
  assert.equal(overview.books[0].scope, 'keyB-CNY')
  assert.equal(overview.totals.amount, 0)
  assert.equal(overview.currentBalance, 50)

  const oldBook = ledgerOverview(ledger, { days: 7, scope: 'keyA-CNY', now: t0 + 3600000 })
  assert.equal(oldBook.active, false)
  assert.equal(oldBook.currentBalance, 100)
  assert.equal(oldBook.todaySummary.amount, 0)
})

test('多币种：同一账户也按币种分本', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 10, currency: 'CNY', scope: 'acct', at: t0 })
  observeBalance(ledger, { balance: 2, currency: 'USD', scope: 'acct', at: t0 + 60000 })
  const overview = ledgerOverview(ledger, { days: 7, now: t0 + 3600000 })
  assert.equal(overview.books.length, 2)
  assert.equal(overview.currency, 'USD')
  assert.equal(overview.currentBalance, 2)
})

test('看板区间：近 N 天含今天、无观测日补零，合计只算有观测的天', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, currency: 'CNY', scope: 'acct', at: Date.parse('2026-10-20T00:01:00+08:00') })
  observeBalance(ledger, { balance: 99, currency: 'CNY', scope: 'acct', at: Date.parse('2026-10-20T12:00:00+08:00') })
  observeBalance(ledger, { balance: 98, currency: 'CNY', scope: 'acct', at: Date.parse('2026-10-21T00:01:00+08:00') })
  observeBalance(ledger, { balance: 97.5, currency: 'CNY', scope: 'acct', at: Date.parse('2026-10-22T00:01:00+08:00') })
  const overview = ledgerOverview(ledger, { days: 7, now: Date.parse('2026-10-22T12:00:00+08:00') })
  assert.equal(overview.from, '2026-10-16')
  assert.equal(overview.to, '2026-10-22')
  assert.equal(overview.days.length, 7)
  assert.equal(overview.totals.count, 3)
  assert.equal(overview.totals.amount, 1)
  assert.equal(overview.totals.month, 1)
  assert.equal(overview.days.filter((d) => !d.observed).length, 4)
  assert.equal(overview.todaySummary.amount, 0)
  assert.equal(overview.lastObservedAt, Date.parse('2026-10-22T00:01:00+08:00'))
})

test('看板区间：days=0 表示全部，从账本第一天开始', () => {
  const ledger = {}
  observeBalance(ledger, { balance: 100, currency: 'CNY', scope: 'acct', at: Date.parse('2026-10-01T00:01:00+08:00') })
  observeBalance(ledger, { balance: 98, currency: 'CNY', scope: 'acct', at: Date.parse('2026-10-01T12:00:00+08:00') })
  const overview = ledgerOverview(ledger, { days: 0, now: Date.parse('2026-10-03T12:00:00+08:00') })
  assert.equal(overview.from, '2026-10-01')
  assert.equal(overview.days.length, 3)
  assert.equal(overview.totals.amount, 2)
})

test('非法输入被拒绝', () => {
  const ledger = {}
  assert.throws(() => observeBalance(ledger, { balance: 1, currency: 'RM', scope: 'a' }), /币种/)
  assert.throws(() => observeBalance(ledger, { balance: 1, currency: 'CNY', scope: 'a b' }), /账户标识/)
  assert.throws(() => observeBalance(ledger, { balance: 'x', currency: 'CNY', scope: 'a' }), /金额/)
  assert.throws(() => reconcileBalance(ledger, { day: 'x', action: 'reset' }), /日期/)
})

console.log('\n' + passed + ' tests passed')
