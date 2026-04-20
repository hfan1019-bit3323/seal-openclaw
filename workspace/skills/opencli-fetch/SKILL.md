---
name: opencli-fetch
description: Convert arbitrary webpages or supported sites into clean Markdown using OpenCLI when available, with graceful fallback when the browser bridge is not ready. Use when the user provides a URL, asks to 抓网页正文、转 Markdown、清洗网页内容、读取文章、保存网页为 Markdown，或 when report-parser / market-news-radar / a-share-analysis need a more stable page-to-markdown step than raw web fetch alone.
---

# OpenCLI 网页转 Markdown

这个 skill 负责把网页尽量稳定地转换成干净 Markdown，优先走 OpenCLI，失败时降级，不因为单点失败卡住任务。

## 目标

支持两类输入：
- 任意 URL → Markdown
- 热门/常见站点文章页 → Markdown

## 当前环境约束

- OpenCLI 已安装后可直接调用。
- `opencli web read` 依赖 Chrome/Chromium + Browser Bridge extension。
- 如果 Browser Bridge 未连接，不要阻塞；直接降级到 `web_fetch`。
- 本 skill 的价值是“封装稳定策略”，不是要求每次都必须由 OpenCLI 成功完成。

## 默认执行顺序

### 路径 A：优先 OpenCLI
当满足以下条件时，优先尝试：
- 需要更干净的正文提取
- 页面较重、常规抓取效果差
- 目标站点是 OpenCLI 更可能处理好的常见内容站点

执行：
1. 调用本地脚本 `scripts/opencli_fetch.sh <url>`。
2. 如果返回 Markdown 文件路径和摘要，则继续使用结果。
3. 如果返回 Browser Bridge 未就绪、站点失败或超时，则进入路径 B。

### 路径 B：降级到 `web_fetch`
- 使用 `web_fetch(url)` 提取 markdown。
- 若结果只有壳页面，再尝试站点栏目页、文章详情页、备用网址或二级来源。
- 输出时标注“由 fallback 链路提取”。

## 适用场景

### 1. report-parser 前置步骤
先把网页或在线文档转成 Markdown，再做结构化解析。

### 2. market-news-radar 前置步骤
对新闻链接批量抽正文，减少广告、导航和噪音。

### 3. a-share-analysis 的证据补齐
对收评、午评、公告解读、机构观点页做正文抽取。

## 输入要求

最小输入：
- 一个 URL

可选输入：
- `site_hint`：如 `eastmoney` / `sinafinance` / `10jqka`
- `prefer_opencli`: true/false
- `save_to`: 输出目录

## 输出要求

至少返回：
- 原始 URL
- 使用的提取路径：`opencli` 或 `fallback:web_fetch`
- Markdown 内容或 Markdown 文件路径
- 如失败，失败原因与下一步建议

## 失败处理

### Browser Bridge 未连接
- 明确标注：OpenCLI 已安装，但浏览器桥未就绪。
- 自动改走 fallback。
- 不把这类失败当成任务失败。

### 页面提取结果过短 / 噪音多
- 尝试改抓文章详情页
- 尝试相关站点二级页面
- 如仍不佳，保留原文摘要并告知用户页面质量有限

## 与现有技能链路的接入建议

- `report-parser`：读取网页/PDF落地页前，先走本 skill
- `market-news-radar`：收集到新闻链接后，先走本 skill 再摘要
- `a-share-analysis`：需要精读某篇收评/机构观点时，把本 skill 作为正文清洗层

## 本地脚本

使用：`scripts/opencli_fetch.sh`

脚本职责：
- 检查 `opencli` 是否存在
- 尝试 `opencli web read`
- 保存提取结果
- 在失败时给出结构化错误，供上层转 fallback
