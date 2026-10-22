# RememberCost（记账本 · dsh-ledger）

一个可以让 DeepSeek Harness 在**下方数据栏**显示剩余余额、今日消费和本会话消耗的插件。

- **数据栏胶囊**：聊天输入框下方显示「记账 今日已用 · 余额 · 本会话」，
  点开可看本月、本会话消耗、最近观测与部分数据说明。
- **设置页看板**：设置 → 记账本，指标卡、按日柱状趋势、逐日明细、余额校正、CSV 导出。
- 记账内核移植自 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
  的 `lib/accounting.mjs`（MIT）：定点金额、余额观测、按账户分本、余额校正、部分数据标记。
- 看板显示参考 [dsh-cost-tracker](https://github.com/Angelyeye/dsh-cost-tracker) 的花费统计页。
- 「本会话」消耗来自同进程的 dsh-cost-tracker（`POST /api/cost-tracker/summary`）；
  没装该插件时这一段自动隐藏，不影响余额记账。

## 口径

DeepSeek 的余额接口不只有总额，还给了「充值余额（`topped_up_balance`）」和
「赠金余额（`granted_balance`）」两个分量。插件**分别观察这两个钱包**：

- 任一钱包增加 = 到账（充值 / 赠金 / 退款），记在 `observedIncrease` / `identifiedIncrease` 里；
- 总额的其余下降 = 消费。即使「充值 20 + 赠金消费 5」发生在同一个观测窗口，也能拆成
  20 到账、5 消费，不需要人工补账，当天数字继续正常累计。
- 首次观测是当天的统计起点；起点离 00:00 或（已经过去的日子）末次观测离次日 00:00
  超过 10 分钟，标为「部分数据」——金额只覆盖已观测时段，不会假装完整。
- 两个分量都取不到时退回总额口径：余额上升只能标「待核对」，用「余额校正」填本区间
  实际累计到账，由「起点余额 + 到账 − 其它扣减 − 当前余额」反推消费。
- 仍有一种拆不开的情况：充值与消费落在**同一个钱包**的同一个观测窗口内（例如赠金花完
  后，又往充值钱包充值、同时从充值钱包扣费）。60 秒周期会把这段净变化当成一笔；
  充值前后点一次「立即记账」可以把窗口压到最小。
- 换 API key / 换账号 = 换一本账（按账户指纹分本），不同记账本**不会相加**；
  旧账本仍可在看板的下拉里查看。

## 余额来源

1. **API Key（优先）**：DSH 凭据服务里的 `DEEPSEEK_API_KEY` → `https://api.deepseek.com/user/balance`。
2. **账号登录（回退）**：没有可用 key 时，走 DSH 的 `deepseekAccount.getBalance()`；
   充值钱包与赠金钱包相加，与官方网页同口径。

两条路都失败时，看板显示 `--` 和失败原因，不会把「不知道」画成 `0`。

## 数据与接口

- 账本：`$DSH_HOME/storages/ledger-accounting.json`（可用 `DSH_LEDGER_FILE` 覆盖）。
  原子写入；文件损坏时改名备份为 `.corrupt-<时间戳>.bak` 后重建，不覆盖坏数据。
- 后台每 60 秒自动观测一次；看板页也提供「立即记账」和自动记账开关。
- HTTP：`POST /api/dsh-ledger/{overview|refresh|reconcile|export|settings}`。
- Agent 工具：
  - `ledger_status`：当前余额、今日已用、观测状态、账本列表；
  - `ledger_days`：逐日明细（区间、部分数据、待核对）；
  - `ledger_reconcile`：余额校正（必须 `confirm: true`）。

## 安装

在 DSH 里用插件管理器安装本目录（`install_bundle`，target 指向本目录），或作为本地 bundle 链接。
安装后打开「设置 → 记账本」，输入框下方的数据栏也会出现「记账」胶囊。

> 更新已安装的本地 bundle 后：宿主侧代码（`index.js` / `accounting.mjs`）要**重启一次 DSH**
> 才会载入新模块；只刷新页面只会更新客户端。看板检测到宿主还是旧版时，会在顶部显示黄色提示条。

## 开发

```bash
npm test
```

包含 18 项记账内核单测、宿主假 ctx 冒烟、以及钱包分量（充值 + 消费同窗口）冒烟。
`accounting.mjs` 是纯逻辑（不读文件、不发请求），修改口径时先补这里的测试。

## 许可

MIT，见 [LICENSE](LICENSE)。记账内核来自 DeepSeek-Balance-Whale-Widget（MIT）；
看板视觉与「本会话消耗」数据口径参考 dsh-cost-tracker（MIT）。
