/**
 * 数据清洗脚本
 * 将 html/ 目录下的章节 HTML 文件解析为纯文本 TXT 文件
 * 提取标题和正文内容，保存到 content/ 目录
 *
 * 支持多站点水印规则：
 *   - 读取 .adapter-cache.json 中的站点缓存规则
 *   - 读取 site-config.json 中的自定义规则
 *   - 通用清洗规则兜底
 *
 * 用法：yarn clean
 */
'use strict';

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const HTML_DIR = path.join(__dirname, '..', 'html');
const OUTPUT_DIR = path.join(__dirname, '..', 'content');
const ADAPTER_CACHE_PATH = path.join(__dirname, '..', '.adapter-cache.json');
const SITE_CONFIG_PATH = path.join(__dirname, '..', 'site-config.json');

// ==================== 水印规则管理 ====================

/**
 * 加载 .adapter-cache.json 中的域名列表
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
 * 加载 site-config.json 中的水印配置
 */
function loadSiteConfig() {
    try {
        if (fs.existsSync(SITE_CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(SITE_CONFIG_PATH, 'utf-8'));
            return config.sites || {};
        }
    } catch (err) {
        console.warn(`加载站点配置失败: ${err.message}`);
    }
    return {};
}

/**
 * 为指定域名构建水印正则列表
 */
function buildWatermarkPatterns(domain, adapterCache, siteConfig) {
    const patterns = [];

    // 1. 通用水印规则
    patterns.push(/https?:\/\/[^\s，。！？、；：""''（）\n]+/g);
    patterns.push(/[\w-]+\.com(?:\.\w+)?/g);

    // 2. hetushu 特有规则（最常用的站点）
    patterns.push(/-?图-?书/g);
    patterns.push(/和-?图-?书/g);
    patterns.push(/和杀阵/g);

    // 3. 探测缓存中的域名规则
    if (domain && adapterCache[domain]) {
        const escapedDomain = domain.replace(/\./g, '\\.');
        patterns.push(new RegExp(escapedDomain, 'g'));
    }

    // 4. site-config.json 中的自定义水印
    if (domain && siteConfig[domain]) {
        const customWatermarks = siteConfig[domain].watermarks || [];
        for (const w of customWatermarks) {
            try {
                patterns.push(new RegExp(w, 'g'));
            } catch {
                // 忽略无效正则
            }
        }
    }

    return patterns;
}

/**
 * 从 index.json 的 startUrl 中提取域名
 */
function extractDomainFromIndex(indexPath) {
    try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        if (index.startUrl) {
            return new URL(index.startUrl).hostname;
        }
    } catch {
        // 忽略
    }
    return null;
}

// ==================== 清洗核心 ====================

/**
 * 清洗文件名中的非法字符
 */
function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

/**
 * 从 HTML 文件中提取标题和正文
 * @param {string} html
 * @param {RegExp[]} watermarkPatterns
 * @returns {{ title: string, content: string }}
 */
function extractContent(html, watermarkPatterns) {
    // 移除 HTML 注释和 <title> 标签
    html = html.replace(/<!--[\s\S]*?-->/g, '');
    html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
    html = html.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');

    // 提取标题（优先副标题 <h2 class="h2">，回退到大标题 <h2>）
    const h2Regex = /<h2([^>]*)>([\s\S]*?)<\/h2>/gi;
    let mainTitle = '';
    let subTitle = '';
    let match;
    while ((match = h2Regex.exec(html)) !== null) {
        const attrs = match[1] || '';
        const text = match[2].replace(/<[^>]+>/g, '').trim();
        if (!text) continue;
        if (/class=["']h2["']/.test(attrs)) {
            subTitle = subTitle || text;
        } else if (!mainTitle) {
            mainTitle = text;
        }
    }
    const title = subTitle || mainTitle || '未知章节';

    // 移除 h2 标签
    html = html.replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, '');

    // 将 <div>、<p>、<br> 替换为换行符
    html = html.replace(/<(div|p)[^>]*>/gi, '\n');
    html = html.replace(/<\/(div|p)>/gi, '');
    html = html.replace(/<br[^>]*\/?>/gi, '\n');

    // 移除所有剩余 HTML 标签
    html = html.replace(/<[^>]+>/g, '');

    // 解码 HTML 实体
    html = html.replace(/&nbsp;/g, ' ');
    html = html.replace(/&lt;/g, '<');
    html = html.replace(/&gt;/g, '>');
    html = html.replace(/&amp;/g, '&');
    html = html.replace(/&quot;/g, '"');
    html = html.replace(/&#39;/g, "'");
    html = html.replace(/&ldquo;/g, '"');
    html = html.replace(/&rdquo;/g, '"');
    html = html.replace(/&lsquo;/g, '\u2018');
    html = html.replace(/&rsquo;/g, '\u2019');
    html = html.replace(/&mdash;/g, '—');
    html = html.replace(/&hellip;/g, '…');

    let contentText = html.trim();

    // 应用所有水印规则
    for (const pattern of watermarkPatterns) {
        contentText = contentText.replace(pattern, '');
    }

    // 合并多余空行
    contentText = contentText.replace(/\n{3,}/g, '\n\n').trim();

    return { title, content: contentText };
}

/**
 * 递归查找目录下所有 HTML 文件
 */
function findHtmlFiles(dir, baseDir) {
    const results = [];
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            results.push(...findHtmlFiles(fullPath, baseDir));
        } else if (entry.endsWith('.html')) {
            const relativePath = path.relative(baseDir, fullPath);
            results.push({ inputPath: fullPath, relativePath });
        }
    }
    return results;
}

// ==================== 处理流程 ====================

/**
 * 处理单个小说目录
 * @param {string} novelName
 * @param {RegExp[]} domainPatterns 该站点特有的水印规则
 */
function processNovel(novelName, domainPatterns) {
    const novelHtmlDir = path.join(HTML_DIR, sanitizeFilename(novelName));
    const novelOutputDir = path.join(OUTPUT_DIR, sanitizeFilename(novelName));

    if (!fs.existsSync(novelHtmlDir)) {
        console.log(`未找到目录: ${novelHtmlDir}`);
        return;
    }

    if (!fs.existsSync(novelOutputDir)) {
        fs.mkdirSync(novelOutputDir, { recursive: true });
    }

    const indexPath = path.join(novelHtmlDir, 'index.json');
    let files;

    if (fs.existsSync(indexPath)) {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        files = [];
        for (const volume of index.volumes) {
            for (const chapter of volume.chapters) {
                const inputPath = path.join(novelHtmlDir, sanitizeFilename(volume.name), chapter.fileName);
                if (!fs.existsSync(inputPath)) {
                    console.warn(`  索引引用文件不存在: ${chapter.fileName}（卷: ${volume.name}）`);
                    continue;
                }
                const relativePath = path.join(sanitizeFilename(volume.name), chapter.fileName);
                files.push({ inputPath, relativePath });
            }
        }
        console.log(`处理小说: ${novelName}，按索引顺序共 ${files.length} 章（${index.volumes.length} 卷）`);
    } else {
        files = findHtmlFiles(novelHtmlDir, novelHtmlDir);
        console.log(`处理小说: ${novelName}，共 ${files.length} 章（无索引，按文件系统顺序）`);
    }

    let successCount = 0;
    for (const { inputPath, relativePath } of files) {
        const html = fs.readFileSync(inputPath, 'utf-8');
        const { title, content } = extractContent(html, domainPatterns);

        if (!content) {
            console.warn(`  跳过空内容: ${relativePath}`);
            continue;
        }

        const outputRelativePath = relativePath.replace(/\.html$/, '.txt');
        const outputPath = path.join(novelOutputDir, outputRelativePath);

        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const txtContent = `${title}\n\n${content}\n`;
        fs.writeFileSync(outputPath, txtContent, 'utf-8');
        successCount++;
    }

    console.log(`  完成: ${successCount}/${files.length} 章已转换为 TXT`);
}

function main() {
    console.log(`HTML 目录: ${HTML_DIR}`);
    console.log(`输出目录: ${OUTPUT_DIR}`);
    console.log('---');

    if (!fs.existsSync(HTML_DIR)) {
        console.error('未找到 html/ 目录，请先运行 `yarn start` 爬取小说');
        process.exit(1);
    }

    const novels = fs.readdirSync(HTML_DIR).filter((f) => {
        const fullPath = path.join(HTML_DIR, f);
        return fs.statSync(fullPath).isDirectory();
    });

    if (novels.length === 0) {
        console.error('html/ 目录下没有找到小说目录');
        process.exit(1);
    }

    const adapterCache = loadAdapterCache();
    const siteConfig = loadSiteConfig();

    for (const novel of novels) {
        const indexPath = path.join(HTML_DIR, sanitizeFilename(novel), 'index.json');
        let domain = null;
        if (fs.existsSync(indexPath)) {
            domain = extractDomainFromIndex(indexPath);
        }

        const patterns = buildWatermarkPatterns(domain, adapterCache, siteConfig);
        if (domain) {
            console.log(`站点域名: ${domain}，水印规则: ${patterns.length} 条`);
        }

        processNovel(novel, patterns);
    }

    console.log('---');
    console.log('数据清洗完成');
}

main();