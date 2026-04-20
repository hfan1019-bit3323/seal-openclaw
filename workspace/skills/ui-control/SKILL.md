---
name: ui-control
description: Control the seal ai frontend UI from within a conversation. Use when the user asks to 创建监控面板、添加自选股、设置价格提醒、打开 Dashboard、跳转到某个页面、让前端显示某个 widget，或 Agent 判断需要在 Dashboard 上持久化一个任务结果时。
---

# 前端 UI 控制

海豹可以通过两种方式驱动前端 UI 变化：即时动作和持久化配置。

## 两种模式

### 模式 A：即时 UI 动作（当次对话有效，不持久）

在消息流里发出 `ui_action` 事件，前端收到后立即执行。
适用于：跳转页面、临时高亮某个区域、弹出提示。

**发出格式**：在回复中嵌入一个 JSON 代码块，标注 `ui_action`：

```ui_action
{
  "action": "navigate",
  "to": "/dashboard"
}
```

```ui_action
{
  "action": "highlight_ticker",
  "ticker": "600519"
}
```

### 模式 B：持久化面板配置（跨 session 保留）

通过调用 runtime `/_internal/panels` API 写入 D1，用户下次打开 Dashboard 仍然存在。
适用于：创建监控 widget、添加自选股面板、设置持续追踪任务。

**执行步骤**：
1. 构造面板配置（见下方面板类型）。
2. 调用 `web_fetch` POST 到 `/_internal/panels`（runtime Worker 地址）。
3. 告知用户"已为你创建 XXX 面板，可在 Dashboard 查看"，并附 `/dashboard` 跳转链接。

**POST 请求格式**：

```json
POST /_internal/panels
Content-Type: application/json
x-seal-user-id: <当前用户 ID>

{
  "type": "stock_watchlist",
  "config": {
    "tickers": ["600519", "000858"],
    "label": "白酒核心持仓"
  },
  "position": { "row": 0, "col": 0 },
  "created_by": "agent"
}
```

**删除面板**：

```
DELETE /_internal/panels/<panel_id>
```

## 面板类型参考

### stock_watchlist — 自选股/持仓追踪

```json
{
  "type": "stock_watchlist",
  "config": {
    "tickers": ["600519", "000858"],
    "label": "白酒核心持仓",
    "show_fields": ["price", "change_pct", "volume"]
  }
}
```

### alert_monitor — 价格 / 条件提醒

```json
{
  "type": "alert_monitor",
  "config": {
    "ticker": "600519",
    "condition": "price_above",
    "threshold": 1800,
    "label": "茅台突破 1800"
  }
}
```

### news_feed — 新闻 / 公告流

```json
{
  "type": "news_feed",
  "config": {
    "tickers": ["600519"],
    "sources": ["eastmoney", "sina"],
    "label": "茅台相关资讯"
  }
}
```

### portfolio — 组合概览

```json
{
  "type": "portfolio",
  "config": {
    "label": "我的组合",
    "tickers": ["600519", "300750", "000858"]
  }
}
```

## 执行原则

- 用户说"帮我盯着 XXX"、"追踪 XXX"、"提醒我 XXX 的时候"→ 优先用模式 B（持久化）。
- 用户说"去看看 Dashboard"、"跳转过去"→ 用模式 A（即时 navigate）。
- 创建持久面板后，**必须在回复里告知用户面板已创建，并给出 `/dashboard` 链接**。
- 不要在用户没有明确要求时自动创建面板（除非是盘后复盘等 Agent 主动任务）。
- 操作完成后用一句话确认：「已在 Dashboard 创建「白酒核心持仓」自选股面板。」
