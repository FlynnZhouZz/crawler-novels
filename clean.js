/**
 * 数据清洗脚本
 * 将 html/ 目录下的章节 HTML 文件解析为纯文本 TXT 文件
 * 提取标题和正文内容，保存到 content/ 目录
 *
 * 用法：yarn clean
 */

'use strict';

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const HTML_DIR = path.join(__dirname, 'html');
const OUTPUT_DIR = path.join(__dirname, 'content');

/**
 * 清洗文件名中的非法字符
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

/**
 * 从 HTML 文件中提取标题和正文
 * @param {string} html
 * @returns {{ title: string, content: string }}
 */
function extractContent(html) {
    // 移除 HTML 注释和 <title> 标签（标题已单独提取）
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

    // 移除 h2 标签（标题已提取，正文中不再保留）
    html = html.replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, '');

    // 将 <div>、<p>、<br> 替换为换行符，保留段落结构
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

    // 提取纯文本
    let contentText = html.trim();

    // 清洗网站水印：URL 链接、"-图-书"、"和-图-书"、"hetushu.com.com" 等
    contentText = contentText.replace(/https?:\/\/[^\s，。！？、；：""''（）\n]+/g, '');
    contentText = contentText.replace(/[\w-]+\.com(?:\.\w+)?/g, '');
    contentText = contentText.replace(/-?图-?书/g, '');
    contentText = contentText.replace(/和-?图-?书/g, '');
    contentText = contentText.replace(/和杀阵/g, '杀阵');
    contentText = contentText.replace(/这，([，。！？、；：""''（）\n])/g, '$1');
    contentText = contentText.replace(/这，([^\s，。！？、；：""''（）\n])/g, '这$1');

    // 合并多余空行（保留一个换行）
    contentText = contentText.replace(/\n{3,}/g, '\n\n').trim();

    return { title, content: contentText };
}

/**
 * 递归查找目录下所有 HTML 文件
 * @param {string} dir
 * @param {string} baseDir
 * @returns {Array<{inputPath: string, relativePath: string}>}
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

/**
 * 处理单个小说目录
 * @param {string} novelName
 */
function processNovel(novelName) {
    const novelHtmlDir = path.join(HTML_DIR, sanitizeFilename(novelName));
    const novelOutputDir = path.join(OUTPUT_DIR, sanitizeFilename(novelName));

    if (!fs.existsSync(novelHtmlDir)) {
        console.log(`未找到目录: ${novelHtmlDir}`);
        return;
    }

    if (!fs.existsSync(novelOutputDir)) {
        fs.mkdirSync(novelOutputDir, { recursive: true });
    }

    const files = findHtmlFiles(novelHtmlDir, novelHtmlDir);
    console.log(`处理小说: ${novelName}，共 ${files.length} 章`);

    let successCount = 0;
    for (const { inputPath, relativePath } of files) {
        const html = fs.readFileSync(inputPath, 'utf-8');
        const { title, content } = extractContent(html);

        if (!content) {
            console.warn(`  跳过空内容: ${relativePath}`);
            continue;
        }

        // 输出文件名与输入文件同名，但扩展名为 .txt，保持目录结构
        const outputRelativePath = relativePath.replace(/\.html$/, '.txt');
        const outputPath = path.join(novelOutputDir, outputRelativePath);

        // 确保输出目录存在
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // 写入 TXT 文件，格式：标题 + 空行 + 正文
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

    for (const novel of novels) {
        processNovel(novel);
    }

    console.log('---');
    console.log('数据清洗完成');
}

main();
