/**
 * 磁碟快取：給「已經收盤、不會再變」的歷史資料用。
 *
 * 記憶體快取（cache.js）重開伺服器就沒了，產業雷達要回看 20 個交易日，
 * 每次重開都重抓會觸發證交所的 WAF。過去交易日的資料寫一次就永遠有效；
 * 當天的資料帶 TTL，盤後定稿前可能還會變。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { RADAR } from './config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, RADAR.cacheDir);

const fileFor = (key) => path.join(DIR, `${key.replace(/[^\w.-]+/g, '_')}.json`);

/**
 * @param {string} key
 * @param {() => Promise<any>} producer
 * @param {{ttlSeconds?: number}} opts 不給 ttl 代表永久有效
 * @returns {Promise<{value:any, source:'disk'|'live'}>}
 */
export async function through(key, producer, { ttlSeconds } = {}) {
  const file = fileFor(key);
  try {
    const hit = JSON.parse(await readFile(file, 'utf8'));
    if (ttlSeconds === undefined || Date.now() - hit.at < ttlSeconds * 1000) {
      return { value: hit.value, source: 'disk' };
    }
  } catch {
    // 沒有快取或檔案壞掉，重抓
  }
  const value = await producer();
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // 寫不進去（唯讀環境）不影響這次的結果
  }
  return { value, source: 'live' };
}
