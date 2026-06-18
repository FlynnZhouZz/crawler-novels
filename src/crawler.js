/**
 * 通用小说爬虫（适配器模式）
 *
 * 通过 FlareSolverr 绕过 Cloudflare，使用适配器模式兼容多站点。
 *
 * 用法：
 *   yarn start <url>                         抓取指定起始章节
 *   yarn start <url> --clean                 抓取后自动清洗
 *   yarn start <url> --detect                仅分析页面结构，不抓取
 *   yarn start <url> --config my-site.json   指定配置文件
 *   yarn start                               使用默认 URL（hetushu.com）
 *
 * 部署 FlareSolverr：
 *   docker run -d --name flaresolverr -p 8191:8191 \
 *     -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 站点适配器
const HetushuAdapter = require('./adapters/HetushuAdapter');
const AutoDetectAdapter = require('./adapters/AutoDetectAdapter');

// ==================== 常量 ====================

const OUTPUT_DIR = path.join(__dirname, '..', 'html');
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';
const REQUEST_DELAY = 1000;
const MAX_RETRY = 3;
const ADAPTER_CACHE_PATH = path.join(__dirname, '..', '.adapter-cache.json');

// 默认起始 URL（未传参时的兜底）
const DEFAULT_START_URL = 'https://www.hetushu.com/book/10319/7209353.html';

// 已知适配器列表（按优先级排列）
const KNOWN_ADAPTERS = [new HetushuAdapter()];

// ==================== 工具函数 ====================

/**
 * 解析命令行参数
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const result = { url: null, clean: false, detect: false, config: null };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--clean') {
            result.clean = true;
        } else if (arg === '--detect') {
            result.detect = true;
        } else if (arg === '--config' && i + 1 < args.length) {
            result.config = args[++i];
        } else if (!arg.startsWith('--')) {
            result.url = arg;
        }
    }

    return result;
}

/**
 * 清洗文件名中的非法字符
 */
function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

/**
 * 通过 FlareSolverr 抓取 URL，返回 solution 对象
 */
async function fetchViaFlareSolverr(url) {
    let response;
    try {
        response = await axios.post(
            FLARESOLVERR_URL,
            {
                cmd: 'request.get',
                url,
                maxTimeout: 60000,
                session: 'crawler-session',
            },
            { timeout: 75000 }
        );
    } catch (err) {
        if (err.code === 'ECONNREFUSED') {
            throw new Error(
                `无法连接 FlareSolverr (${FLARESOLVERR_URL})。\n` +
                    `请先启动 FlareSolverr 服务，详见文档顶部注释。`
            );
        }
        throw err;
    }
    const data = response.data;
    if (!data || data.status !== 'ok') {
        throw new Error(`FlareSolverr 返回错误: ${(data && data.message) || JSON.stringify(data).slice(0, 200)}`);
    }
    return data.solution;
}

/**
 * 加载 site-config.json
 */
function loadSiteConfig(configPath) {
    const rootDir = path.join(__dirname, '..');
    const paths = configPath
        ? [configPath, path.join(rootDir, configPath)]
        : [path.join(rootDir, 'site-config.json')];

    for (const p of paths) {
        if (fs.existsSync(p)) {
            try {
                const raw = fs.readFileSync(p, 'utf-8');
                const config = JSON.parse(raw);
                console.log(`已加载站点配置: ${p}`);
                return config.sites || {};
            } catch (err) {
                console.warn(`加载配置失败 ${p}: ${err.message}`);
            }
        }
    }
    return {};
}

/**
 * 基于 site-config.json 创建适配器
 */
function createConfigAdapter(domain, siteConfig) {
    const cfg = siteConfig[domain];
    if (!cfg) return null;

    const SiteAdapter = require('./adapters/SiteAdapter');
    const adapter = new SiteAdapter();

    adapter.match = () => true;

    adapter.extractNovelName = ($) => {
        if (cfg.novelName) {
            const el = $(cfg.novelName.selector);
            const val = cfg.novelName.attribute ? el.attr(cfg.novelName.attribute) : el.text();
            if (val) return val.trim();
        }
        return '未知小说';
    };

    adapter.extractContent = ($) => {
        if (cfg.content && cfg.content.selector) {
            const el = $(cfg.content.selector);
            return el.length > 0 ? el : $('body');
        }
        return $('body');
    };

    adapter.extractTitles = ($, contentDiv) => {
        let mainTitle = '';
        let subTitle = '';
        if (cfg.titles) {
            if (cfg.titles.mainTitle) {
                const el = $(cfg.titles.mainTitle);
                if (el.length) mainTitle = el.text().trim();
            }
            if (cfg.titles.subTitle) {
                const el = $(cfg.titles.subTitle);
                if (el.length) subTitle = el.text().trim();
            }
        }
        return { mainTitle, subTitle };
    };

    adapter.getNextUrl = ($, currentUrl) => {
        if (cfg.nextPage) {
            const el = $(cfg.nextPage.selector);
            if (el.length > 0) {
                const href = cfg.nextPage.attribute ? el.attr(cfg.nextPage.attribute) : el.attr('href');
                if (href && href !== '#' && !href.startsWith('javascript:')) {
                    return resolveUrl(href, currentUrl);
                }
            }
        }
        return null;
    };

    adapter.getWatermarkPatterns = () => {
        return (cfg.watermarks || []).map((w) => new RegExp(w, 'g'));
    };

    adapter.getCache = () => ({
        domain,
        novelName: null,
        contentSelector: cfg.content ? cfg.content.selector : null,
        mainTitleSelector: cfg.titles ? cfg.titles.mainTitle : null,
        subTitleSelector: cfg.titles ? cfg.titles.subTitle : null,
        nextSelector: cfg.nextPage ? cfg.nextPage.selector : null,
        watermarks: cfg.watermarks || [],
        encoding: cfg.encoding || 'utf-8',
    });

    return adapter;
}

/**
 * 解析相对 URL
 */
function resolveUrl(href, currentUrl) {
    if (href.startsWith('http')) return href;
    try {
        return new URL(href, currentUrl).href;
    } catch {
        try {
            const base = new URL(currentUrl);
            return base.origin + (href.startsWith('/') ? href : '/' + href);
        } catch {
            return href;
        }
    }
}

/**
 * 选择适配器
 * 流程：配置 > 已知适配器 > 自动探测
 */
function selectAdapter(url, siteConfig) {
    let domain = '';
    try {
        domain = new URL(url).hostname;
    } catch {
        domain = 'unknown';
    }

    // 1. 检查 site-config.json 是否有该站点的配置
    const configAdapter = createConfigAdapter(domain, siteConfig);
    if (configAdapter) {
        console.log(`使用配置适配器: ${domain}`);
        return configAdapter;
    }

    // 2. 尝试已知适配器
    for (const adapter of KNOWN_ADAPTERS) {
        if (adapter.match(url)) {
            console.log(`使用已知适配器: ${adapter.constructor.name}`);
            return adapter;
        }
    }

    // 3. 自动探测（兜底）
    console.log('使用自动探测适配器');
    const autoAdapter = new AutoDetectAdapter();

    // 检查是否有缓存
    const cache = loadAdapterCache();
    if (cache && cache[domain]) {
        autoAdapter.cache = cache[domain];
        console.log(`已加载探测缓存: ${domain}`);
    }

    return autoAdapter;
}

/**
 * 加载探测结果缓存
 */
function loadAdapterCache() {
    try {
        if (fs.existsSync(ADAPTER_CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(ADAPTER_CACHE_PATH, 'utf-8'));
        }
    } catch (err) {
        console.warn(`加载探测缓存失败: ${err.message}`);
    }
    return {};
}

/**
 * 保存探测结果缓存
 */
function saveAdapterCache(domain, cacheData) {
    try {
        const cache = loadAdapterCache();
        cache[domain] = cacheData;
        fs.writeFileSync(ADAPTER_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
        console.log(`探测结果已缓存: ${ADAPTER_CACHE_PATH}`);
    } catch (err) {
        console.warn(`保存探测缓存失败: ${err.message}`);
    }
}

// ==================== 爬取核心 ====================

/**
 * 抓取并保存单个章节
 */
async function crawlChapter(url, novelName, index, state, adapter) {
    let solution = null;
    let lastErr = null;
    for (let i = 0; i < MAX_RETRY; i++) {
        try {
            solution = await fetchViaFlareSolverr(url);
            break;
        } catch (err) {
            lastErr = err;
            console.warn(`请求失败(${i + 1}/${MAX_RETRY}): ${err.message}`);
            await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        }
    }
    if (!solution) {
        throw new Error(`无法访问 ${url}: ${lastErr ? lastErr.message : '未知错误'}`);
    }
    const html = solution.response;

    const $ = cheerio.load(html, { decodeEntities: false });
    const contentDiv = adapter.extractContent($);
    if (!contentDiv || contentDiv.length === 0) {
        console.log('未找到正文内容，结束爬取');
        return null;
    }
    const contentHtml = contentDiv.html();
    if (!contentHtml || contentHtml.trim().length === 0) {
        console.log('正文内容为空，结束爬取');
        return null;
    }

    // 提取标题
    const { mainTitle, subTitle } = adapter.extractTitles($, contentDiv);

    // 大标题作为卷目录名
    const volumeName = mainTitle || state.currentVolume || '未知卷';

    // 新卷首次出现时注册
    if (!state.volumeMap[volumeName]) {
        state.volumeMap[volumeName] = { name: volumeName, chapters: [] };
        state.volumeOrder.push(volumeName);
    }
    state.currentVolume = volumeName;

    // 文件名用副标题（章节名），不带序号前缀
    const fileBaseName = subTitle || `chapter_${index}`;
    const novelDir = path.join(OUTPUT_DIR, sanitizeFilename(novelName));
    const volumeDir = path.join(novelDir, sanitizeFilename(volumeName));
    const fileName = `${sanitizeFilename(fileBaseName)}.html`;
    const filePath = path.join(volumeDir, fileName);

    // 包装为完整 HTML 文件
    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${subTitle || mainTitle || fileBaseName}</title>
</head>
<body>
${contentHtml}
</body>
</html>
`;

    if (!fs.existsSync(volumeDir)) {
        fs.mkdirSync(volumeDir, { recursive: true });
    }
    fs.writeFileSync(filePath, fullHtml, 'utf-8');
    console.log(`[${index}] 已保存: ${filePath}`);

    // 计算内容哈希
    const contentHash = crypto.createHash('md5').update(fullHtml, 'utf-8').digest('hex');

    // 记录到卷章节列表
    state.volumeMap[volumeName].chapters.push({
        index,
        fileName,
        url,
        contentHash,
    });

    // 获取下一页
    const nextUrl = adapter.getNextUrl($, url);

    return { nextUrl, chapter: { index, url, volumeName, fileName, filePath, contentHash } };
}

/**
 * 生成 index.json 索引文件
 */
function generateIndex(novelName, state, startUrl, totalChapters, crawlDate) {
    const novelDir = path.join(OUTPUT_DIR, sanitizeFilename(novelName));
    const indexPath = path.join(novelDir, 'index.json');

    const index = {
        novelName,
        startUrl,
        crawlDate,
        totalChapters,
        volumes: state.volumeOrder.map((volumeName, orderIndex) => {
            const vol = state.volumeMap[volumeName];
            return {
                order: orderIndex + 1,
                name: vol.name,
                chapterCount: vol.chapters.length,
                chapters: vol.chapters.map((ch) => ({
                    index: ch.index,
                    fileName: ch.fileName,
                    url: ch.url,
                    contentHash: ch.contentHash,
                })),
            };
        }),
    };

    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
    console.log(`索引文件已生成: ${indexPath}`);
}

/**
 * 校验已爬取文件的完整性
 */
function validateFiles(novelName) {
    const novelDir = path.join(OUTPUT_DIR, sanitizeFilename(novelName));
    const indexPath = path.join(novelDir, 'index.json');

    if (!fs.existsSync(indexPath)) {
        console.log('未找到 index.json，无法校验');
        return { valid: 0, invalid: [] };
    }

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    let valid = 0;
    const invalid = [];

    for (const volume of index.volumes) {
        for (const chapter of volume.chapters) {
            const filePath = path.join(novelDir, sanitizeFilename(volume.name), chapter.fileName);
            if (!fs.existsSync(filePath)) {
                invalid.push({ fileName: filePath, expected: chapter.contentHash, actual: null });
                continue;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const actualHash = crypto.createHash('md5').update(content, 'utf-8').digest('hex');
            if (actualHash === chapter.contentHash) {
                valid++;
            } else {
                invalid.push({ fileName: filePath, expected: chapter.contentHash, actual: actualHash });
            }
        }
    }

    return { valid, invalid };
}

// ==================== 主流程 ====================

async function main() {
    const args = parseArgs();
    const startUrl = args.url || DEFAULT_START_URL;

    console.log(`FlareSolverr 地址: ${FLARESOLVERR_URL}`);
    console.log(`起始 URL: ${startUrl}`);

    // 加载站点配置
    const siteConfig = loadSiteConfig(args.config);

    // 选择适配器
    const adapter = selectAdapter(startUrl, siteConfig);

    // 获取域名（用于缓存键）
    let domain = '';
    try {
        domain = new URL(startUrl).hostname;
    } catch {
        domain = 'unknown';
    }

    // 第一次访问获取页面
    let firstSolution = null;
    let lastErr = null;
    for (let i = 0; i < MAX_RETRY; i++) {
        try {
            firstSolution = await fetchViaFlareSolverr(startUrl);
            break;
        } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        }
    }
    if (!firstSolution) {
        throw new Error(`无法获取起始页面: ${lastErr ? lastErr.message : '未知错误'}`);
    }

    const firstHtml = firstSolution.response;
    if (/Just a moment|请稍候|进行安全验证/.test(firstHtml)) {
        throw new Error('FlareSolverr 返回的仍是 Cloudflare 挑战页，请确认 FlareSolverr 服务正常运行');
    }

    // 自动探测适配器：分析首页结构
    if (adapter instanceof AutoDetectAdapter && !adapter.hasCache()) {
        console.log('正在分析页面结构...');
        const detectResult = adapter.detect(firstHtml, startUrl);
        console.log('探测结果:');
        console.log(`  小说名: ${detectResult.novelName}`);
        console.log(`  内容选择器: ${detectResult.contentSelector}`);
        console.log(`  大标题选择器: ${detectResult.mainTitleSelector || '（自动）'}`);
        console.log(`  小标题选择器: ${detectResult.subTitleSelector || '（自动）'}`);
        console.log(`  下一页选择器: ${detectResult.nextSelector || '（未找到）'}`);
        console.log(`  上一页选择器: ${detectResult.prevSelector || '（未找到）'}`);
        console.log(`  编码: ${detectResult.encoding}`);

        // 保存缓存
        saveAdapterCache(domain, detectResult);

        // --detect 模式：仅分析不爬取
        if (args.detect) {
            console.log('\n--detect 模式，分析完成，不执行爬取。');
            console.log('提示: 可将上述探测结果写入 site-config.json 以固化配置。');
            return;
        }

        // 如果没有找到下一页，提示用户
        if (!detectResult.nextSelector) {
            console.warn('\n警告: 未自动探测到下一页链接，爬取可能只能抓取第一页。');
            console.warn('建议在 site-config.json 中手动配置 nextPage 选择器。');
        }
    }

    // 提取小说名
    const cheerioFirst = cheerio.load(firstHtml, { decodeEntities: false });
    const novelName = adapter.extractNovelName(cheerioFirst);
    console.log(`小说名: ${novelName}`);

    // 如果是 --detect 模式但使用已知适配器，已经打印了信息，直接返回
    if (args.detect && !(adapter instanceof AutoDetectAdapter)) {
        console.log('\n--detect 模式，分析完成，不执行爬取。');
        return;
    }

    // 爬取循环
    let currentUrl = startUrl;
    let index = 1;
    const state = {
        currentVolume: '',
        volumeOrder: [],
        volumeMap: {},
    };

    while (currentUrl) {
        try {
            const result = await crawlChapter(currentUrl, novelName, index, state, adapter);
            if (!result) break;
            currentUrl = result.nextUrl;
            index++;
            await new Promise((r) => setTimeout(r, REQUEST_DELAY));
        } catch (err) {
            console.error(`第 ${index} 章爬取失败: ${err.message}`);
            break;
        }
    }

    const totalChapters = index - 1;
    const crawlDate = new Date().toISOString();

    console.log(`\n爬取完成，共 ${totalChapters} 章`);

    if (totalChapters > 0) {
        // 生成索引文件
        generateIndex(novelName, state, startUrl, totalChapters, crawlDate);

        // 校验文件完整性
        const { valid, invalid } = validateFiles(novelName);
        console.log(`文件校验: ${valid} 个通过, ${invalid.length} 个失败`);
        if (invalid.length > 0) {
            console.warn('以下文件校验失败:');
            for (const item of invalid) {
                console.warn(`  - ${item.fileName} (期望: ${item.expected}, 实际: ${item.actual || '文件不存在'})`);
            }
        }

        console.log(`输出目录: ${path.join(OUTPUT_DIR, sanitizeFilename(novelName))}`);
    }

    // --clean 模式：自动执行数据清洗
    if (args.clean && totalChapters > 0) {
        console.log('\n--clean 模式，自动执行数据清洗...');
        require('child_process').execSync('node src/clean.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    }
}

main().catch((err) => {
    console.error('程序异常:', err.message);
    process.exit(1);
});