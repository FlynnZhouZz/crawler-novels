/**
 * HetushuAdapter - 和图书 (hetushu.com) 站点适配器
 *
 * 从当前 crawler.js 中抽取的 hetushu.com 专用逻辑。
 */
'use strict';

const SiteAdapter = require('./SiteAdapter');

class HetushuAdapter extends SiteAdapter {
    match(url) {
        return url.includes('hetushu.com');
    }

    extractNovelName($) {
        const title = $('title').text().trim();
        const m = title.split(/\s*[-–—]\s*/);
        return m.length >= 2 ? m[m.length - 1].trim() : title;
    }

    extractContent($) {
        return $('#content');
    }

    extractTitles($, contentDiv) {
        let mainTitle = '';
        let subTitle = '';
        if (!contentDiv) return { mainTitle, subTitle };
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
        return { mainTitle, subTitle };
    }

    getNextUrl($, currentUrl) {
        const nextLink = $('a#next');
        if (nextLink.length === 0) return null;
        const href = (nextLink.attr('href') || '').trim();
        if (!href || href === '#' || href.startsWith('javascript:')) return null;
        return this._resolveUrl(href, currentUrl);
    }

    getPrevUrl($, currentUrl) {
        const prevLink = $('a#prev');
        if (prevLink.length === 0) return null;
        const href = (prevLink.attr('href') || '').trim();
        if (!href || href === '#' || href.startsWith('javascript:')) return null;
        return this._resolveUrl(href, currentUrl);
    }

    getWatermarkPatterns() {
        return [
            /https?:\/\/[^\s，。！？、；：""''（）\n]+/g,
            /[\w-]+\.com(?:\.\w+)?/g,
            /-?图-?书/g,
            /和-?图-?书/g,
            /和杀阵/g,
        ];
    }

    /**
     * 将相对 URL 解析为绝对 URL
     */
    _resolveUrl(href, currentUrl) {
        if (href.startsWith('http')) return href;
        try {
            const base = new URL(currentUrl);
            return new URL(href, base.origin).href;
        } catch {
            return 'https://www.hetushu.com' + href;
        }
    }
}

module.exports = HetushuAdapter;