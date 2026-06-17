# crawler-novels

爬取小说网站（hetushu.com）全文章节的 Node.js 工具。
通过 FlareSolverr 绕过 Cloudflare 反爬，每章保存为独立 HTML 文件。

## 功能

- 自动从起始章节页开始抓取
- 抓取 `<div id="content">` 节点内容，识别 `<h2>`（大标题）和 `<h2 class="h2">`（副标题/章节名）
- 通过 `<a id="next">` 自动翻页，循环抓取到末尾
- 每章保存为 `html/{小说名}/{序号}_{章节名}.html`
- 章节间隔自动重试，处理 FlareSolverr 临时失败

## 环境要求

- Node.js >= 18
- Yarn
- Docker（或 Python 3，用于运行 FlareSolverr）

## 安装

```bash
yarn install
```

## 启动 FlareSolverr

FlareSolverr 是一个本地服务，专门用于绕过 Cloudflare 挑战。本项目通过 HTTP 调用它获取已验证的页面。

### 方式 A：Docker（推荐）

```bash
docker run -d --name flaresolverr -p 8191:8191 -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest
```

首次启动会下载内置 Chrome，等 10-30 秒。查看日志确认就绪：

```bash
docker logs -f flaresolverr
# 看到 "Server listening on port 8191" 即就绪
```

### 方式 B：Python 直接跑

```bash
git clone https://github.com/FlareSolverr/FlareSolverr.git
cd FlareSolverr
pip install -r requirements.txt
python src/start.py
```

## 运行爬虫

```bash
yarn start
```

正常输出示例：

```
FlareSolverr 地址: http://localhost:8191/v1
开始爬取: https://www.hetushu.com/book/10319/7209353.html
小说名: 吞噬星空
[1] 已保存: html\吞噬星空\0001_第九章 归来.html
[2] 已保存: html\吞噬星空\0002_第十章 采购.html
...
没有下一页，爬取结束

爬取完成，共 N 章，输出目录: html\吞噬星空
```

## 配置

环境变量（写入项目根目录的 `.env` 文件）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FLARESOLVERR_URL` | `http://localhost:8191/v1` | FlareSolverr 服务地址 |
| `CF_COOKIE` | （无） | 已废弃（旧 cookie 方案遗留），可忽略 |

爬虫启动参数在 [crawler.js](file:///d:\benji\project\crawler-novels\crawler.js) 顶部：

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `START_URL` | `https://www.hetushu.com/book/10319/7209353.html` | 起始章节地址 |
| `OUTPUT_DIR` | `./html` | 章节 HTML 输出目录 |
| `REQUEST_DELAY` | `1000` | 章节间请求间隔（毫秒） |
| `MAX_RETRY` | `3` | 单个章节失败重试次数 |

## 输出结构

```
html/
└── 吞噬星空/
    ├── 0001_第九章 归来.html
    ├── 0002_第十章 采购.html
    ├── ...
    └── 1521_完结感言.html
```

每个 HTML 文件结构：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>第九章 归来</title></head>
<body>
  <h2>第七卷 九河圣界</h2>
  <h2 class="h2">第九章 归来</h2>
  <p>章节正文段落...</p>
</body>
</html>
```

## 抓取原理

- 起始链接：https://www.hetushu.com/book/10319/7209353.html
- 抓取 `<div id="content">` 标签内的内容
- `<h2>第七卷 九河圣界</h2>` 为大标题
- `<h2 class="h2">第九章 归来</h2>` 为副标题
- 其他内容为小说正文

### 保存方式

先将 `<div id="content">` 内容抓取下来，保存为 HTML 文件，存到 `html/{当前小说名称}` 目录下。一章就是一个 HTML 文件。

### 下一页

下一页按钮 DOM 为 `<a href="/book/10319/7209354.html" id="next" class="next" title="..."></a>`，程序自动翻页，然后继续爬取步骤循环。直至下一页没有或者下一页没有内容。

## 性能

FlareSolverr 每页处理时间约 5-15 秒（首次会慢一些）。整本《吞噬星空》约 1500+ 章，预计 2-6 小时。爬取过程完全无人值守。

## 清洗数据

先完成爬取，后续完善清洗。
