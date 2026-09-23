/**
 * HTTP 伺服器：靜態檔 + JSON API。
 *
 * 刻意不使用 Express —— 這支服務只有五條路由，Node 內建的 http
 * 就夠了，換來的是零執行期依賴（不必 npm install 就能跑）。
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as api from './src/api.js';
import { PORT, OFFLINE } from './src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 1e6; // 個人化設定不該有 1MB 這麼大，超過就拒收

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('請求內容過大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('請求內容不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);

  // 防止 ../ 逃出 public 目錄
  if (!target.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: '路徑不允許' });
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');

    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': body.length,
      // 開發期間不要快取，避免改了 UI 看不到
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 找不到頁面');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, await api.health());
    }

    if (url.pathname === '/api/search') {
      return sendJson(res, 200, await api.search(url.searchParams.get('q') || ''));
    }

    if (url.pathname === '/api/technical') {
      return sendJson(res, 200, await api.technical(Object.fromEntries(url.searchParams)));
    }

    if (url.pathname === '/api/dashboard') {
      // GET 也支援（空白設定），方便用瀏覽器或 curl 直接看
      const body = req.method === 'POST' ? await readBody(req) : {};
      return sendJson(res, 200, await api.dashboard(body));
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: `未知的端點 ${url.pathname}` });
    }

    return await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(`[error] ${req.method} ${url.pathname}:`, err.message);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`台股脈動 → http://localhost:${PORT}`);
  if (OFFLINE) console.log('（離線模式：使用 data/ 下的樣本資料，不對外連線）');
});
