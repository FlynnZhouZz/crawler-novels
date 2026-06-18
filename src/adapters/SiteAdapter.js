/**
 * SiteAdapter 基类
 *
 * 所有站点适配器必须继承此类并实现以下方法。
 * 每个适配器负责将特定站点的 HTML 解析为统一结构。
 */
'use strict';

class SiteAdapter {
    /**
     * 判断当前适配器是否匹配该 URL
     * @param {string} url
     * @returns {boolean}
     */
    match(url) {
        throw new Error('未实现 match()');
    }

    /**
     * 从页面 HTML 中提取小说名
     * @param {import('cheerio').CheerioAPI} $
     * @returns {string}
     */
    extractNovelName($) {
        throw new Error('未实现 extractNovelName()');
    }

    /**
     * 从页面中提取正文内容区域
     * @param {import('cheerio').CheerioAPI} $
     * @returns {import('cheerio').Cheerio | null} 内容容器元素
     */
    extractContent($) {
        throw new Error('未实现 extractContent()');
    }

    /**
     * 从内容区域中提取标题信息
     * @param {import('cheerio').CheerioAPI} $
     * @param {import('cheerio').Cheerio | null} contentDiv
     * @returns {{ mainTitle: string, subTitle: string }}
     */
    extractTitles($, contentDiv) {
        throw new Error('未实现 extractTitles()');
    }

    /**
     * 获取下一页链接
     * @param {import('cheerio').CheerioAPI} $
     * @param {string} currentUrl
     * @returns {string | null}
     */
    getNextUrl($, currentUrl) {
        throw new Error('未实现 getNextUrl()');
    }

    /**
     * 获取上一页链接（可选，用于自动探测时验证）
     * @param {import('cheerio').CheerioAPI} $
     * @param {string} currentUrl
     * @returns {string | null}
     */
    getPrevUrl($, currentUrl) {
        return null;
    }

    /**
     * 站点特有的水印/广告关键词列表（用于清洗）
     * @returns {RegExp[]}
     */
    getWatermarkPatterns() {
        return [];
    }
}

module.exports = SiteAdapter;