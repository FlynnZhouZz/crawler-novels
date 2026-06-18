/**
 * AutoDetectAdapter - 自动探测适配器
 *
 * 当 URL 不匹配任何已知站点时，通过启发式规则自动分析页面结构。
 * 实施文档 docs/001-通用小说爬虫架构设计.md 中定义的五层探测策略。
 *
 * 使用方式：
 *   1. 实例化适配器
 *   2. 调用 detect(html, url) 分析首页并缓存探测结果
 *   3. 后续页面直接使用 extractContent/extractTitles/getNextUrl 等标准方法
 */
'use strict';

const SiteAdapter = require('./SiteAdapter');

// 内容区域候选 id
const CONTENT_IDS = [
    'content',
    'nr_content',
    'bookcontent',
    'chaptercontent',
    'chapterContent',
    'text',
    'article',
    'main',
    'readcontent',
    'chapter',
    'book_content',
    'txtContent',
    'contentbox',
    'chaptercontent',
    'readContents',
    'articlecontent',
];

// 内容区域候选 class
const CONTENT_CLASSES = [
    'content',
    'nr_content',
    'bookcontent',
    'chapter-content',
    'text-content',
    'readcontent',
    'chapter',
    'chapter_content',
    'txtContent',
    'contentbox',
    'article-content',
    'main-content',
];

// 下一页候选选择器
const NEXT_SELECTORS = [
    'a#next',
    'a.next',
    '#next_page a',
    '.next_page a',
    '#nextchapter',
    'a[title*="下一"]',
    'a[title*="next"]',
    'a.nextchapter',
    '.nextchapter',
];

class AutoDetectAdapter extends SiteAdapter {
    constructor() {
        super();
        /** @type {null|{domain:string,novelName:string,contentSelector:string,mainTitleSelector:string,subTitleSelector:string,nextSelector:string,prevSelector:string,watermarks:string[],encoding:string}} */
        this.cache = null;
    }

    /**
     * 匹配所有 URL（作为兜底适配器）
     */
    match(url) {
        return true;
    }

    /**
     * 是否已完成探测
     */
    hasCache() {
        return this.cache !== null;
    }

    /**
     * 获取缓存（供 clean.js 读取水印规则等）
     */
    getCache() {
        return this.cache;
    }

    /**
     * 分析页面结构并缓存探测结果
     * @param {string} html 页面 HTML
     * @param {string} url  页面 URL
     * @returns {{novelName:string,contentSelector:string,mainTitleSelector:string,subTitleSelector:string,nextSelector:string,prevSelector:string,watermarks:string[],encoding:string}}
     */
    detect(html, url) {
        const cheerio = require('cheerio');
        const $ = cheerio.load(html, { decodeEntities: false });
        let domain = '';
        try {
            domain = new URL(url).hostname;
        } catch {
            domain = 'unknown';
        }

        const novelName = this._detectNovelName($);
        const contentSelector = this._detectContentSelector($);
        const { mainTitleSelector, subTitleSelector } = this._detectTitleSelectors($, contentSelector);
        const { nextSelector, prevSelector } = this._detectPageSelectors($, url);
        const encoding = this._detectEncoding($, html);

        this.cache = {
            domain,
            novelName,
            contentSelector,
            mainTitleSelector,
            subTitleSelector,
            nextSelector,
            prevSelector,
            watermarks: [domain],
            encoding,
        };

        return this.cache;
    }

    // ==================== 书名提取 ====================

    /**
     * 探测小说名（5 级优先级）
     */
    _detectNovelName($) {
        // 优先级 1: <meta property="og:novel:book_name">
        let name = $('meta[property="og:novel:book_name"]').attr('content');
        if (name) return name.trim();

        // 优先级 2: <meta name="og:novel:book_name">
        name = $('meta[name="og:novel:book_name"]').attr('content');
        if (name) return name.trim();

        // 优先级 3: 面包屑导航中最后一个链接文本
        const breadcrumbs = $('.breadcrumb a, .crumbs a, .nav a, .path a');
        if (breadcrumbs.length >= 2) {
            const last = $(breadcrumbs[breadcrumbs.length - 1]).text().trim();
            if (last && last.length < 30) return last;
        }

        // 优先级 4: <title> 标签，按常见分隔符分割后取第一段
        const title = $('title').text().trim();
        if (title) {
            const bookMatch = title.match(/《(.+?)》/);
            if (bookMatch) return bookMatch[1].trim();

            const sepMatch = title.split(/\s*[-–—|_]\s*/);
            if (sepMatch.length >= 2) {
                const parts = sepMatch.map((s) => s.trim()).filter(Boolean);
                if (parts.length >= 2) {
                    const shortest = parts.reduce((a, b) => (a.length <= b.length ? a : b));
                    return shortest;
                }
            }
            return title;
        }

        // 优先级 5: 页面中最大的 <h1> 标签文本
        const h1 = $('h1').first();
        if (h1.length) {
            const h1Text = h1.text().trim();
            if (h1Text) return h1Text;
        }

        return '未知小说';
    }

    // ==================== 正文内容探测 ====================

    /**
     * 探测正文内容区域选择器（5 层策略）
     * @returns {string} CSS 选择器
     */
    _detectContentSelector($) {
        // 策略 1: 查找 id 包含 content/text/article/chapter 的元素
        for (const id of CONTENT_IDS) {
            const el = $(`#${id}`);
            if (el.length > 0 && el.text().trim().length > 100) {
                return `#${id}`;
            }
        }

        // 策略 2: 查找 class 包含 content/text/chapter 的元素
        const classCandidates = [];
        for (const cls of CONTENT_CLASSES) {
            const els = $(`.${cls}`);
            if (els.length > 0) {
                els.each((_, el) => {
                    const textLen = $(el).text().trim().length;
                    if (textLen > 100) {
                        classCandidates.push({ selector: `.${cls}`, el, textLen });
                    }
                });
            }
        }

        // 策略 3: 如果有多个 class 候选，选择文本最长的
        if (classCandidates.length > 0) {
            classCandidates.sort((a, b) => b.textLen - a.textLen);
            return classCandidates[0].selector;
        }

        // 策略 4: 查找 <p> 标签最密集的父容器
        const divCandidates = [];
        $('div').each((_, el) => {
            const $el = $(el);
            const text = $el.text().trim();
            if (text.length < 200) return;
            const pCount = $el.find('p').length;
            if (pCount < 3) return;
            const score = pCount * 10 + text.length / 100;
            if (score > 0) {
                divCandidates.push({ el: $el, score, selector: this._getUniqueSelector($el) });
            }
        });

        if (divCandidates.length > 0) {
            divCandidates.sort((a, b) => b.score - a.score);
            return divCandidates[0].selector;
        }

        // 策略 5: 兜底 — 取 <body>
        return 'body';
    }

    /**
     * 获取元素的唯一选择器
     */
    _getUniqueSelector($el) {
        if ($el.attr('id')) return `#${$el.attr('id')}`;
        const cls = $el.attr('class');
        if (cls) {
            const cleanCls = cls.trim().split(/\s+/).join('.');
            return `.${cleanCls}`;
        }
        const parent = $el.parent();
        if (parent.length) {
            let idx = 1;
            parent.children().each((i, child) => {
                if (child === $el[0]) idx = i + 1;
            });
            const tag = $el[0].tagName || 'div';
            return `${tag}:nth-child(${idx})`;
        }
        return 'body';
    }

    // ==================== 标题提取 ====================

    /**
     * 探测标题选择器
     */
    _detectTitleSelectors($, contentSelector) {
        let mainTitleSelector = null;
        let subTitleSelector = null;

        // 策略 1: 内容区域内的 h1、h2、h3
        const contentEl = $(contentSelector);
        if (contentEl.length) {
            const headings = contentEl.find('h1, h2, h3');
            if (headings.length >= 1) {
                const firstTag = headings[0].tagName || 'h2';
                const firstClass = $(headings[0]).attr('class') || '';
                mainTitleSelector = firstClass
                    ? `${firstTag}.${firstClass.trim().split(/\s+/).join('.')}`
                    : `${firstTag}`;

                if (headings.length >= 2) {
                    const secondTag = headings[1].tagName || 'h2';
                    const secondClass = $(headings[1]).attr('class') || '';
                    subTitleSelector = secondClass
                        ? `${secondTag}.${secondClass.trim().split(/\s+/).join('.')}`
                        : `${secondTag}`;
                }
                return { mainTitleSelector, subTitleSelector };
            }
        }

        // 策略 2: 内容区域外的标题
        const pageH1 = $('h1').first();
        if (pageH1.length && pageH1.text().trim().length > 0) {
            mainTitleSelector = 'h1';
            const pageH2 = $('h2').first();
            if (pageH2.length && pageH2.text().trim().length > 0) {
                const cls = pageH2.attr('class') || '';
                subTitleSelector = cls ? `h2.${cls.trim().split(/\s+/).join('.')}` : 'h2';
            }
            return { mainTitleSelector, subTitleSelector };
        }

        return { mainTitleSelector: null, subTitleSelector: null };
    }

    // ==================== 翻页探测 ====================

    /**
     * 探测翻页链接选择器
     */
    _detectPageSelectors($, url) {
        let nextSelector = null;
        let prevSelector = null;

        // 优先级 1: 已知选择器
        for (const sel of NEXT_SELECTORS) {
            const el = $(sel);
            if (el.length > 0) {
                const href = el.attr('href') || '';
                if (href && href !== '#' && !href.startsWith('javascript:')) {
                    nextSelector = sel;
                    break;
                }
            }
        }

        // 优先级 2: 文本包含 "下一章"、"下一页" 的 <a> 标签
        if (!nextSelector) {
            $('a').each((_, el) => {
                const text = $(el).text().trim();
                const href = $(el).attr('href') || '';
                if (!href || href === '#' || href.startsWith('javascript:')) return;
                if (/下一(章|页)|>>|next/i.test(text)) {
                    nextSelector = this._getUniqueSelector($(el));
                    return false;
                }
            });
        }

        // 优先级 3: 同目录文件名数字 +1 的链接
        if (!nextSelector) {
            try {
                const currentUrl = new URL(url);
                const pathParts = currentUrl.pathname.split('/');
                const lastPart = pathParts[pathParts.length - 1];
                const numMatch = lastPart.match(/(\d+)/);
                if (numMatch) {
                    const currentNum = parseInt(numMatch[1], 10);
                    const nextNum = currentNum + 1;
                    const nextPattern = lastPart.replace(numMatch[1], String(nextNum));

                    $('a').each((_, el) => {
                        const href = $(el).attr('href') || '';
                        if (href.includes(nextPattern)) {
                            nextSelector = this._getUniqueSelector($(el));
                            return false;
                        }
                    });
                }
            } catch {
                // URL 解析失败，忽略
            }
        }

        // 优先级 4: 查找同一目录下数字递增的链接
        if (!nextSelector) {
            try {
                const currentUrl = new URL(url);
                const baseDir = currentUrl.pathname.substring(0, currentUrl.pathname.lastIndexOf('/') + 1);
                const candidates = [];
                $('a').each((_, el) => {
                    const href = $(el).attr('href') || '';
                    if (href.startsWith(baseDir)) {
                        const numMatch = href.match(/(\d+)/g);
                        if (numMatch && numMatch.length > 0) {
                            const lastNum = parseInt(numMatch[numMatch.length - 1], 10);
                            candidates.push({ href, num: lastNum, el });
                        }
                    }
                });
                if (candidates.length > 0) {
                    const currentNumMatch = currentUrl.pathname.match(/(\d+)/g);
                    if (currentNumMatch) {
                        const currentNum = parseInt(currentNumMatch[currentNumMatch.length - 1], 10);
                        const target = candidates.find((c) => c.num === currentNum + 1);
                        if (target) {
                            nextSelector = this._getUniqueSelector($(target.el));
                        }
                    }
                }
            } catch {
                // 忽略
            }
        }

        // 上一页探测
        $('a').each((_, el) => {
            const text = $(el).text().trim();
            const href = $(el).attr('href') || '';
            if (!href || href === '#' || href.startsWith('javascript:')) return;
            if (/上一(章|页)|<<|prev/i.test(text)) {
                prevSelector = this._getUniqueSelector($(el));
                return false;
            }
        });

        if (!prevSelector && nextSelector) {
            try {
                const currentUrl = new URL(url);
                const currentNumMatch = currentUrl.pathname.match(/(\d+)/g);
                if (currentNumMatch) {
                    const currentNum = parseInt(currentNumMatch[currentNumMatch.length - 1], 10);
                    const baseDir = currentUrl.pathname.substring(0, currentUrl.pathname.lastIndexOf('/') + 1);
                    $('a').each((_, el) => {
                        const href = $(el).attr('href') || '';
                        if (href.startsWith(baseDir)) {
                            const numMatch = href.match(/(\d+)/g);
                            if (numMatch) {
                                const lastNum = parseInt(numMatch[numMatch.length - 1], 10);
                                if (lastNum === currentNum - 1) {
                                    prevSelector = this._getUniqueSelector($(el));
                                    return false;
                                }
                            }
                        }
                    });
                }
            } catch {
                // 忽略
            }
        }

        return { nextSelector, prevSelector };
    }

    /**
     * 探测页面编码
     */
    _detectEncoding($, html) {
        const charsetMeta = $('meta[charset]').attr('charset');
        if (charsetMeta) return charsetMeta.trim().toLowerCase();

        const contentTypeMeta = $('meta[http-equiv="Content-Type"]').attr('content');
        if (contentTypeMeta) {
            const m = contentTypeMeta.match(/charset=([\w-]+)/i);
            if (m) return m[1].toLowerCase();
        }

        if (html.length >= 3) {
            const buf = Buffer.from(html.slice(0, 3));
            if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
        }

        return 'utf-8';
    }

    // ==================== 标准接口实现 ====================

    extractNovelName($) {
        return this.cache ? this.cache.novelName : '未知小说';
    }

    extractContent($) {
        if (!this.cache || !this.cache.contentSelector) return $('body');
        const el = $(this.cache.contentSelector);
        return el.length > 0 ? el : $('body');
    }

    extractTitles($, contentDiv) {
        let mainTitle = '';
        let subTitle = '';

        if (this.cache) {
            if (this.cache.mainTitleSelector) {
                const el = $(this.cache.mainTitleSelector);
                if (el.length) mainTitle = el.text().trim();
            }
            if (this.cache.subTitleSelector) {
                const el = $(this.cache.subTitleSelector);
                if (el.length) subTitle = el.text().trim();
            }
        }

        if (!mainTitle && !subTitle && contentDiv) {
            contentDiv.find('h1, h2, h3').each((_, el) => {
                const $el = $(el);
                const text = $el.text().trim();
                if (!text) return;
                const tag = (el.tagName || '').toLowerCase();
                const cls = $el.attr('class') || '';
                if (tag === 'h1') {
                    mainTitle = mainTitle || text;
                } else if (tag === 'h2' && cls) {
                    subTitle = subTitle || text;
                } else if (tag === 'h2' && !mainTitle) {
                    mainTitle = text;
                } else if (!subTitle) {
                    subTitle = subTitle || text;
                }
            });
        }

        if (!mainTitle && !subTitle) {
            const titleText = $('title').text().trim();
            if (titleText) {
                const parts = titleText.split(/\s*[-–—|_]\s*/);
                if (parts.length >= 2) {
                    subTitle = parts[0].trim();
                    mainTitle = parts[parts.length - 1].trim();
                } else {
                    subTitle = titleText;
                }
            }
        }

        return { mainTitle, subTitle };
    }

    getNextUrl($, currentUrl) {
        if (!this.cache || !this.cache.nextSelector) return null;
        const el = $(this.cache.nextSelector);
        if (el.length === 0) return null;
        const href = (el.attr('href') || '').trim();
        if (!href || href === '#' || href.startsWith('javascript:')) return null;
        return this._resolveUrl(href, currentUrl);
    }

    getPrevUrl($, currentUrl) {
        if (!this.cache || !this.cache.prevSelector) return null;
        const el = $(this.cache.prevSelector);
        if (el.length === 0) return null;
        const href = (el.attr('href') || '').trim();
        if (!href || href === '#' || href.startsWith('javascript:')) return null;
        return this._resolveUrl(href, currentUrl);
    }

    getWatermarkPatterns() {
        const patterns = [
            /https?:\/\/[^\s，。！？、；：""''（）\n]+/g,
            /[\w-]+\.com(?:\.\w+)?/g,
        ];
        if (this.cache && this.cache.domain) {
            patterns.push(new RegExp(this.cache.domain.replace(/\./g, '\\.'), 'g'));
        }
        return patterns;
    }

    /**
     * 将相对 URL 解析为绝对 URL
     */
    _resolveUrl(href, currentUrl) {
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
}

module.exports = AutoDetectAdapter;