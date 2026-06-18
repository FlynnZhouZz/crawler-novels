/**
 * 小说爬虫（通过 FlareSolverr 绕过 Cloudflare）
 *
 * 部署 FlareSolverr（任选其一）：
 *   方式 A（推荐，需 Docker）：
 *     docker run -d --name flaresolverr -p 8191:8191 -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest
 *   方式 B（Python 直接跑）：
 *     git clone https://github.com/FlareSolverr/FlareSolverr.git
 *     cd FlareSolverr && pip install -r requirements.txt && python src/start.py
 *
 * 抓取流程：
 *   1. 每章都通过 FlareSolverr request.get 接口获取（保证每页都过 Cloudflare 验证）
 *   2. 抓取 <div id="content"> 内容
 *   3. <h2> 大标题（卷名），<h2 class="h2"> 副标题（章节名）
 *   4. 每章保存为 html/{小说名}/{卷名}/{序号}_{章节名}.html
 *   5. 通过 <a id="next"> 翻页，递归至无下一页
 *   6. 爬取完成后生成 index.json 索引文件（含校验信息）
 */

'use strict';

require('dotenv').config();

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.hetushu.com';
const START_URL = 'https://www.hetushu.com/book/10319/7209353.html';
const OUTPUT_DIR = path.join(__dirname, 'html');
// FlareSolverr 服务地址，端口默认 8191
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';
// 章节间请求间隔（毫秒），FlareSolverr 自身处理时间约 5~15s，间隔可小一些
const REQUEST_DELAY = 1000;
// 单个章节最多重试次数
const MAX_RETRY = 3;

/**
 * 清洗文件名中的非法字符
 * @param {string} name
 * @returns {string}
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
                // 让 FlareSolverr 内部复用 session（同一 UA + cookies）
                session: 'crawler-session',
            },
            { timeout: 75000 }
        );
    } catch (err) {
        if (err.code === 'ECONNREFUSED') {
            throw new Error(
                `无法连接 FlareSolverr (${FLARESOLVERR_URL})。\n` +
                    `请先启动 FlareSolverr 服务，详见 crawler.js 顶部注释。`
            );
        }
        throw err;
    }
    const data = response.data;
    if (!data || data.status !== 'ok') {
        throw new Error(`FlareSolverr 返回错误: ${(data && data.message) || JSON.stringify(data).slice(0, 200)}`);
    }
    return data.solution; // { url, status, headers, response, cookies, userAgent }
}

/**
 * 从页面 title 中提取小说名
 */
function extractNovelName(html) {
    const $ = cheerio.load(html, { decodeEntities: false });
    const title = $('title').text().trim();
    const m = title.split(/\s*[-–—]\s*/);
    if (m.length >= 2) return m[m.length - 1].trim();
    return title || '未知小说';
}

/**
 * 抓取并保存单个章节，返回章节信息或 null（结束爬取）
 * @param {string} url
 * @param {string} novelName
 * @param {number} index
 * @param {{ currentVolume: string, volumeOrder: string[], volumeMap: Object<string, {name: string, chapters: Array}> }} state
 * @returns {Promise<{nextUrl: string | null, chapter: {index: number, url: string, volumeName: string, fileName: string, filePath: string, contentHash: string}} | null>}
 */
async function crawlChapter(url, novelName, index, state) {
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
    const contentDiv = $('#content');
    if (contentDiv.length === 0) {
        console.log('未找到 #content 节点，结束爬取（可能 FlareSolverr 未生效或页面结构变化）');
        return null;
    }
    const contentHtml = contentDiv.html();
    if (!contentHtml || contentHtml.trim().length === 0) {
        console.log('#content 内容为空，结束爬取');
        return null;
    }

    // 识别大标题（<h2>，卷名）和副标题（<h2 class="h2">，章节名）
    let mainTitle = '';
    let subTitle = '';
    contentDiv.find('h2').each((_, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        if (!text) return;
        if ($el.attr('class') === 'h2') {
            subTitle = subTitle || text;
        } else if (!mainTitle) {
            mainTitle = text;
        }
    });

    // 大标题作为卷目录名，若本章没有大标题则沿用上一章的卷名
    const volumeName = mainTitle || state.currentVolume || '未知卷';

    // 新卷首次出现时，注册到卷顺序列表
    if (!state.volumeMap[volumeName]) {
        state.volumeMap[volumeName] = { name: volumeName, chapters: [] };
        state.volumeOrder.push(volumeName);
    }
    state.currentVolume = volumeName;

    // 文件名用副标题（章节名），不带序号前缀（顺序由 index.json 维护）
    const fileBaseName = subTitle || `chapter_${index}`;
    const novelDir = path.join(OUTPUT_DIR, sanitizeFilename(novelName));
    const volumeDir = path.join(novelDir, sanitizeFilename(volumeName));
    const fileName = `${sanitizeFilename(fileBaseName)}.html`;
    const filePath = path.join(volumeDir, fileName);

    // 包装为完整 HTML 文件，方便直接打开阅读
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

    // 计算内容哈希（用于校验文件完整性）
    const contentHash = crypto.createHash('md5').update(fullHtml, 'utf-8').digest('hex');

    // 记录到卷的章节列表
    state.volumeMap[volumeName].chapters.push({
        index,
        fileName,
        url,
        contentHash,
    });

    // 获取下一页
    const nextLink = $('a#next');
    let nextUrl = null;
    if (nextLink.length > 0) {
        const nextHref = (nextLink.attr('href') || '').trim();
        if (nextHref && nextHref !== '#' && !nextHref.startsWith('javascript:')) {
            nextUrl = nextHref.startsWith('http') ? nextHref : BASE_URL + nextHref;
        }
    }

    return { nextUrl, chapter: { index, url, volumeName, fileName, filePath, contentHash } };
}

/**
 * 生成 index.json 索引文件
 * @param {string} novelName
 * @param {{ volumeOrder: string[], volumeMap: Object<string, {name: string, chapters: Array}> }} state
 * @param {string} startUrl
 * @param {number} totalChapters
 * @param {string} crawlDate
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
 * @param {string} novelName
 * @returns {{ valid: number, invalid: Array<{fileName: string, expected: string, actual: string | null}> }}
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

async function main() {
    console.log(`FlareSolverr 地址: ${FLARESOLVERR_URL}`);
    console.log(`开始爬取: ${START_URL}`);

    // 第一次访问确定小说名
    let firstSolution = null;
    let lastErr = null;
    for (let i = 0; i < MAX_RETRY; i++) {
        try {
            firstSolution = await fetchViaFlareSolverr(START_URL);
            break;
        } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        }
    }
    if (!firstSolution) {
        throw new Error(`无法获取起始页面: ${lastErr ? lastErr.message : '未知错误'}`);
    }

    // 简单校验：可能 FlareSolverr 没解掉挑战
    const firstHtml = firstSolution.response;
    if (/Just a moment|请稍候|进行安全验证/.test(firstHtml)) {
        throw new Error('FlareSolverr 返回的仍是 Cloudflare 挑战页，请确认 FlareSolverr 服务正常运行');
    }

    const novelName = extractNovelName(firstHtml);
    console.log(`小说名: ${novelName}`);

    let currentUrl = START_URL;
    let index = 1;
    const state = {
        currentVolume: '',
        volumeOrder: [],
        volumeMap: {},
    };

    while (currentUrl) {
        try {
            const result = await crawlChapter(currentUrl, novelName, index, state);
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

    // 生成索引文件
    generateIndex(novelName, state, START_URL, totalChapters, crawlDate);

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

main().catch((err) => {
    console.error('程序异常:', err.message);
    process.exit(1);
});
