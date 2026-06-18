/**
 * 临时调试脚本 - 测试 title 提取
 */
const axios = require('axios');
const cheerio = require('cheerio');

(async () => {
    try {
        const res = await axios.post('http://localhost:8191/v1', {
            cmd: 'request.get',
            url: 'https://www.hetushu.com/book/10319/7209353.html',
            maxTimeout: 30000,
        });
        const html = res.data.solution.response;
        const $ = cheerio.load(html, { decodeEntities: false });

        const title = $('title').text();
        console.log('TITLE:', JSON.stringify(title));

        const og = $('meta[property="og:novel:book_name"]').attr('content');
        console.log('OG:', JSON.stringify(og));

        const parts = title.split(/[-–—]/);
        console.log('PARTS:', JSON.stringify(parts));
        console.log('PARTS[0]:', JSON.stringify((parts[0] || '').trim()));
        console.log('PARTS[1]:', JSON.stringify((parts[1] || '').trim()));
        console.log('PARTS[last]:', JSON.stringify((parts[parts.length - 1] || '').trim()));

        process.exit(0);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
})();