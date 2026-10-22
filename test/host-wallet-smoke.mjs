// ============================================================
// 钱包分量冒烟测试：宿主把 toppedUp/bonus 传进内核，
// 并验证「充值 + 消费同窗口」能被拆开。
// 运行：node test/host-wallet-smoke.mjs
// ============================================================

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-wallet-'))
const dataFile = join(dir, 'ledger.json')
process.env.DSH_LEDGER_FILE = dataFile

let wallet = { total: 100, top: 90, bonus: 10 }
globalThis.fetch = async () => new Response(JSON.stringify({
  balance_infos: [{
    currency: 'CNY',
    total_balance: String(wallet.total),
    granted_balance: String(wallet.bonus),
    topped_up_balance: String(wallet.top),
  }],
}), { status: 200, headers: { 'content-type': 'application/json' } })

const cleanups = []
const routes = new Map()
const tools = new Map()
const ctx = {
  effect(fn) { cleanups.push(fn()) },
  on() { return () => {} },
  get(name) {
    if (name === 'credentials') return { resolve: async () => ({ value: 'wallet-key' }) }
    if (name === 'deepseekAccount') return null
    return undefined
  },
  webServer: { register(route) { routes.set(route.path, route); return () => {} } },
  tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
}

const mod = await import('../index.js')
mod.apply(ctx)

function makeReq(path, body) {
  const text = JSON.stringify(body || {})
  return {
    method: 'POST',
    url: path,
    async *[Symbol.asyncIterator]() { yield Buffer.from(text, 'utf8') },
  }
}
function makeRes() {
  const state = { code: 0, text: '' }
  return {
    writeHead(code) { state.code = code },
    end(text) { state.text = text },
    get result() { return { code: state.code, body: JSON.parse(state.text || '{}') } },
  }
}
async function call(route, body) {
  const res = makeRes()
  await routes.get('/api/dsh-ledger').handler(makeReq('/api/dsh-ledger/' + route, body), res)
  return res.result
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 5))

const first = await call('refresh', { days: 7 })
assert.equal(first.body.ok, true)
assert.equal(first.body.todaySummary.amount, 0)
assert.equal(first.body.balance.toppedUp, 90)
assert.equal(first.body.balance.bonus, 10)
await pause()

// 充值 20 进充值钱包；同时赠金消费 5 —— 总额只净升 15，但两个钱包的分量能拆开。
wallet = { total: 115, top: 110, bonus: 5 }
const second = await call('refresh', { days: 7 })
assert.equal(second.body.todaySummary.amount, 5)
assert.equal(second.body.todaySummary.observedIncrease, 20)
assert.equal(second.body.todaySummary.identifiedIncrease, 20)
assert.equal(second.body.todaySummary.needsReview, false)
assert.equal(second.body.todaySummary.label, '已观测消费 · 已识别到账')
await pause()

// 之后再消费 2（赠金 5 -> 3），消费继续累计。
wallet = { total: 113, top: 110, bonus: 3 }
const third = await call('refresh', { days: 7 })
assert.equal(third.body.todaySummary.amount, 7)
assert.equal(third.body.todaySummary.observedIncrease, 20)
assert.equal(third.body.balance.total, 113)

const raw = JSON.parse(readFileSync(dataFile, 'utf8'))
const row = raw.accounting.books[raw.accounting.active].days[third.body.today]
assert.equal(row.verifiedCreditUnits, 2000000000)
assert.equal(row.debitUnits, 700000000)
assert.equal(row.creditUnits, 2000000000)

const daysTool = await tools.get('ledger_days').execute({ days: 7 })
assert.equal(daysTool.count, 1)
assert.equal(daysTool.days[0].amount, 7)
assert.equal(daysTool.days[0].identifiedIncrease, 20)

for (const dispose of cleanups) {
  if (typeof dispose === 'function') dispose()
}
rmSync(dir, { recursive: true, force: true })
console.log('host wallet smoke ok')
