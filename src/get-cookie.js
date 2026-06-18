/**
 * 引导用户获取 Cloudflare cookie，并写入 .env
 * 用法：yarn get-cookie
 */
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const GUIDE = `
============================================================
如何获取 Cloudflare cookie
============================================================

1. 在 Chrome / Edge 打开 https://www.hetushu.com/
   （首次会触发 Cloudflare "请稍候…" 验证，等待 3~5 秒后自动进入）

2. 访问任意一章节，例如：
   https://www.hetushu.com/book/10319/7209353.html

3. 打开 DevTools (F12) -> Network 面板 -> 点任意一个请求
   （比如 www.hetushu.com 那个 html 文档）

4. 在右侧 Headers 面板中，往下滚找到 "Cookie:" 或 "cookie:" 字段

5. 把整行值（从 cf_clearance=xxx; ... 开始到末尾）整段复制出来

6. 粘贴到下方提示行，回车确认

   提示：整段内容里可能含分号、空格、逗号，
   直接整行粘贴即可，无需手动转义。
============================================================
请粘贴 Cookie 字符串：
`;

async function prompt() {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(GUIDE, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function writeEnv(cookie) {
    const envExamplePath = path.join(__dirname, '..', '.env.example');
    if (!fs.existsSync(envExamplePath)) {
        fs.writeFileSync(envExamplePath, '# 从浏览器 DevTools -> Network -> Cookie 整行复制\nCF_COOKIE=\n', 'utf-8');
    }
    const content = `# 从浏览器 DevTools -> Network -> Cookie 整行复制\nCF_COOKIE=${cookie}\n`;
    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    console.log(`\n已写入 ${ENV_PATH}`);
    console.log('接下来可以运行: yarn start\n');
}

(async () => {
    const cookie = await prompt();
    if (!cookie) {
        console.log('未输入内容，退出');
        process.exit(0);
    }
    if (cookie.length < 20) {
        console.log('Cookie 太短，请确认是否复制完整（应至少含 cf_clearance=xxx）');
        process.exit(1);
    }
    if (!/cf_clearance=/.test(cookie)) {
        console.log('警告：Cookie 中未检测到 cf_clearance 字段，请确认复制正确');
    }
    writeEnv(cookie);
})();