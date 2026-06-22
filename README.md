# crawler-novels

通用小说爬虫工具，通过 FlareSolverr 绕过 Cloudflare 反爬，支持多站点自动适配。

## 功能

- 适配器模式架构，兼容任意小说网站
- 已知站点（hetushu.com）使用专用适配器，精确解析
- 未知站点通过启发式规则自动探测页面结构（内容区域、标题、翻页链接）
- 探测结果缓存，避免重复分析
- 支持 `site-config.json` 手动配置选择器（兜底自动探测失败情况）
- 自动翻页，循环抓取到末尾
- 每章保存为独立 HTML 文件，按卷目录组织
- 爬取完成后生成 `index.json` 索引（含 MD5 文件完整性校验）
- 数据清洗脚本将 HTML 转换为纯文本 TXT
- `--detect` 模式仅分析页面结构，不执行爬取
- `--clean` 模式爬取完成后自动执行数据清洗

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
docker run -d --name flaresolverr -p 8191:8191 \
    -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest
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

### 基本用法（默认抓取 hetushu.com 的《吞噬星空2：起源大陆》）

```bash
yarn start
```

### 指定起始章节 URL

```bash
yarn start https://www.hetushu.com/book/10319/7209353.html
```

### 探测模式（仅分析页面结构，不爬取）

```bash
yarn start https://www.example.com/chapter/1 --detect
# 或
yarn detect https://www.example.com/chapter/1
```

### 爬取后自动清洗

```bash
yarn start https://www.example.com/chapter/1 --clean
```

### 指定站点配置文件

```bash
yarn start https://www.example.com/chapter/1 --config my-site.json
```

### 仅数据清洗

```bash
yarn clean
```

## 适配器架构

项目使用**适配器模式**兼容不同小说网站：

```
site-config.json（统一配置入口，所有站点适配在此管理）
    │
    ├── hetushu.com       — 和图书配置
    ├── example.com       — 其他站点配置
    └── AutoDetectAdapter — 自动探测适配器（未配置的站点兜底）
```

### 适配器选择流程

1. **site-config.json** — 查找当前域名是否有配置，有则直接使用
2. **自动探测** — 未配置的未知站点，通过启发式规则分析页面结构，结果缓存到 `.adapter-cache.json`

### 自动探测策略

当访问未知站点时，自动探测适配器使用以下策略：

| 项目 | 策略 |
|------|------|
| 小说名 | meta 标签 → 面包屑导航 → title 标签分割 → h1 标签 |
| 正文内容 | id 匹配 → class 匹配 → p 标签密度 → body 兜底 |
| 标题 | 内容区域内 h1/h2 → 页面 h1 → title 标签 |
| 翻页 | id/class 匹配 → 文本匹配("下一章") → URL 数字递增 |
| 编码 | meta charset → Content-Type → BOM 头 |

### 手动配置

当自动探测失败时，在 `site-config.json` 中手动配置：

```json
{
    "sites": {
        "example.com": {
            "novelName": {
                "selector": "meta[property='og:novel:book_name']",
                "attribute": "content"
            },
            "content": {
                "selector": "#chaptercontent"
            },
            "titles": {
                "mainTitle": "h1",
                "subTitle": "h2.chapter-title"
            },
            "nextPage": {
                "selector": "a.next",
                "attribute": "href"
            },
            "watermarks": ["example\\.com", "广告词"],
            "encoding": "utf-8"
        }
    }
}
```

## 配置

### 环境变量（写入项目根目录的 `.env` 文件）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FLARESOLVERR_URL` | `http://localhost:8191/v1` | FlareSolverr 服务地址 |

### 爬虫运行参数

| 参数 | 说明 |
| --- | --- |
| `<url>` | 起始章节 URL（不传则使用默认 hetushu.com 地址） |
| `--clean` | 爬取完成后自动执行数据清洗 |
| `--detect` | 仅分析页面结构，不执行爬取 |
| `--config <path>` | 指定站点配置文件路径 |

## 输出结构

```
outputs/
├── html/
│   └── 吞噬星空2：起源大陆/
│       ├── index.json                        # 索引文件（卷顺序、章节顺序、MD5 校验）
│       ├── 第七卷 九河圣界/
│       │   ├── 第九章 归来.html
│       │   ├── 第十章 采购.html
│       │   └── ...
│       └── ...
└── content/
    └── 吞噬星空2：起源大陆/
        ├── 第七卷 九河圣界/
        │   ├── 第九章 归来.txt
        │   ├── 第十章 采购.txt
        │   └── ...
        └── ...
```

- `<h2>` 大标题作为卷目录名
- `<h2 class="h2">` 小标题作为文件名
- 若某章没有大标题，沿用上一章的卷名
- 若大标题包含"第X章"，说明没有卷结构，文件直接放在小说目录下
- **文件名不带序号前缀**，顺序由 `index.json` 维护
- `index.json` 记录每章的 MD5 哈希值，用于文件完整性校验
- 可通过 `.env` 中的 `BASE_OUTPUT_DIR` 自定义输出基目录（默认 `outputs`）

## 数据清洗

爬取完成后，运行清洗脚本将 HTML 转换为纯文本 TXT 文件：

```bash
yarn clean
```

清洗逻辑：
- 提取标题（优先副标题，回退大标题）
- 保留段落结构（`<div>`、`<p>` 转为换行）
- 移除网站水印（URL、域名、站点特有广告词等）
- 支持多站点水印规则（读取 `.adapter-cache.json` 和 `site-config.json`）
- 输出到 `outputs/content/{小说名}/` 目录，保持与 HTML 相同的卷目录结构

## 项目结构

```
crawler-novels/
├── src/                         # 源代码
│   ├── crawler.js               # 通用爬取引擎
│   ├── clean.js                 # 通用清洗脚本
│   ├── get-cookie.js            # Cookie 获取工具
│   └── adapters/                # 站点适配器
│       ├── SiteAdapter.js       #   基类
│       └── AutoDetectAdapter.js #   自动探测适配器
├── site-config.json             # 站点适配配置（统一管理所有站点选择器规则）
├── .adapter-cache.json          # 探测结果缓存（自动生成，已 gitignore）
├── package.json
├── .env
├── .gitignore
├── jsconfig.json
├── outputs/                     # 输出目录（可通过 BASE_OUTPUT_DIR 自定义）
│   ├── html/                    #   爬取输出
│   │   └── {小说名}/
│   │       ├── index.json
│   │       └── {卷名}/
│   │           └── {章节名}.html
│   └── content/                 #   清洗输出
│       └── {小说名}/
│           └── {卷名}/
│               └── {章节名}.txt
└── docs/
    └── 001-通用小说爬虫架构设计.md
```

## 性能

FlareSolverr 每页处理时间约 5-15 秒（首次会慢一些）。整本小说约 1500+ 章，预计 2-6 小时。
自动探测首次会增加约 1-2 秒开销（仅首页分析，后续章节使用缓存）。
爬取过程完全无人值守。