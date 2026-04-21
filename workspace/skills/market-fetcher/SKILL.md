---
name: market-fetcher
description: A股市场数据获取。当你需要板块资金流、龙虎榜、指数行情、涨停池、北向资金等结构化数据时使用。优先读缓存（6ms），缓存缺失再触发实时抓取，不要直接用 agent-browser 抓这些数据。
---

# market-fetcher skill

## 调用原则（严格遵守）

1. **默认先读缓存**：调 `market.read_latest(task_id)`。命中则直接用，延迟 ~6ms。
2. **缓存缺失或超过 1 个交易日未更新**：调 `market.fetch_now(task_id, args)`，同步获取新数据。
3. **用户反复问同类数据，且清单里没有该任务**：调 `market.schedule()`，**不弹 confirm**，事后用自然语言告知用户。
   例如："我给你加了一条：每个交易日 15:30 自动拉取板块资金流，不用的时候跟我说就行。"
4. **用户说"不要自动抓"或"取消"**：调 `market.unschedule(task_id)`。

## 已有任务清单（首批 5 个）

| task_id          | 数据内容           | 抓取频率（交易日） |
|------------------|--------------------|-------------------|
| `sector-flows`   | 板块资金流向排名   | 每 10 分钟，9-15 时 |
| `dragon-tiger`   | 龙虎榜             | 每 30 分钟，13-16 时 |
| `index-daily`    | 三大指数日行情     | 每 10 分钟，9-15 时 |
| `limit-up`       | 涨停池             | 每 10 分钟，9-15 时 |
| `north-flow`     | 北向资金累计流入   | 每 15 分钟，9-15 时 |

新任务可用 `market.list_tasks()` 查看完整清单。

## 接口规范

所有接口均通过 runtime `https://seal-runtime-hfan.hfan1019.workers.dev/api/market/` 访问。
鉴权：`Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>`（与 Gateway connect frame token 同值）。

### market.read_latest(task_id)

```
GET /api/market/latest?type={task_id}
```

响应：
```json
{ "hit": true, "task_id": "sector-flows", "data": { ... } }
// 或 404 { "hit": false } — 缓存未命中，改用 fetch_now
```

### market.fetch_now(task_id, akshare_fn, args?)

```
POST /api/market/fetch
{ "task_id": "sector-flows", "akshare_fn": "stock_sector_fund_flow_rank", "args": {"indicator": "今日"} }
```

响应：
```json
{ "ok": true, "result": { "type": "dataframe", "columns": [...], "data": [...] } }
```

最坏延迟约 21s（东财 soft-throttle 尾延迟），在 Worker subrequest 限制内。

### market.list_tasks()

```
GET /api/market/manifest
```

返回完整 manifest JSON，含 task_id / cron / disabled / staging 字段。

### market.schedule(task_id, cron, akshare_fn, args?, kv_key?, ttl_s?)

```
PUT /api/market/manifest
{
  "id": "sector-flows-custom",
  "cron": "*/10 9-15 * * 1-5",
  "akshare_fn": "stock_sector_fund_flow_rank",
  "args": { "indicator": "今日" },
  "ttl_s": 600
}
```

护栏（自动校验，不可绕过）：
- cron 最快 `*/5`，不接受每分钟一次
- akshare_fn 必须在 allowlist 内
- 每个 AI 最多创建 20 条任务
- 新任务前 2 次为 dry-run（写 `market:staging:<id>`，验证通过后自动提升）

### market.unschedule(task_id)

```
DELETE /api/market/manifest/{task_id}
```

## 已知 akshare_fn allowlist

```
stock_sector_fund_flow_rank     板块资金流向排名
stock_lhb_detail_em             龙虎榜（东财）
index_zh_a_hist                 A股主要指数历史行情
stock_zt_pool_em                涨停池（东财）
stock_hsgt_north_acc_flow_in_em 北向资金累计净流入
```

如需其他函数，告知用户当前 allowlist 的范围，不要尝试调用 allowlist 之外的函数。

## 错误处理

- `404 hit:false` → 调 `fetch_now`
- `400 not in allowlist` → 告知用户当前不支持该数据，建议使用已有 task_id
- `429 limit reached` → 告知用户 AI 任务上限 20 条，请先 `unschedule` 不用的任务
- `5xx` 或 fetch 超时 → 降级：改用 `agent-browser` 抓同源网页（临时方案），并记录 "market-fetcher 暂时不可用"
