// index.js - CLOUDSTREAM COMPATIBLE VERSION
// Google Drive Stremio Addon v1.0.5 - Service Accounts from ENV
// Loads Google Service Account credentials securely from environment variables.

require('dotenv').config(); // Load environment variables from .env file
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");
const timeout = require("connect-timeout");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Timeout middleware (must be before routes)
app.use(timeout("60s"));
app.use((req, res, next) => {
  if (!req.timedout) next();
});

// ========= CONFIG (centralized with timeouts) =========
const CONFIG = {
  addonName: "GDrive v1.0.5",
  baseUrl: process.env.BASE_URL || "http://127.0.0.1:3000", // Use environment variable for base URL
  rootFolders: [
    { id: "1X18vIlx0I74wcXLYFYkKs1Xo_vW9jw6i", name: "Hindi Dubbed" },
    { id: "1-NwN-Rxwwaxe9baXu26owKMXP5urzLQ4", name: "Crunchyroll" },
    { id: "1-qKf0GOsySvIZMpMjE6-SwcGe40opFGM", name: "Bollywood" },
    { id: "18llWh5xMxb8J3FcJDCYX3RXlrcG7zZKs", name: "Animated Movies" },
    { id: "15No1zGvyaQ4ZeEJK7naXmVsigKXRHorL", name: "New Web Series" },
    { id: "1vOxJULycYIir_fklIzT9stfSsu6_m99o", name: "Hindi Web Series" },
    { id: "1kNiheEQTfld1wpaYsMsZ8O6cLXHSTIKN", name: "Web Series" },
    { id: "1Vh5tuHzrEZ0al-3iOAvgcjTLb0GBnwiZ", name: "Web Series-II" },
    { id: "1KN7A8GvwVgbZ12tYfV_FXlqT0q3Me-zO", name: "Web Series Watched" },
    { id: "1R3S20D0kbDlA9jCIpfBH-bTWQKQ2pw-C", name: "Korean Hindi Dubbed" },
    { id: "1RERSOWOUrCn_q3qv0PeBxY9ieX-h0pO4", name: "Korean EngSUB Dubbed" },
    { id: "1gS3vE823nz3xc7sz_LLwyYoi8xf-4n9y", name: "Anime+" },
    { id: "1Ud-TL-zWUWUTEPXzwU9B21XCmUFAeFDI", name: "Hindi Dubbed Collection" },
    { id: "1GB8QbOXv7cieHFSOKkD2SjgHSdNIiYjQ", name: "Turkish Drama" }
  ],
  downloadTokenExpiry: 60 * 10,
  apiRequestTimeoutMs: 30_000,
  fetchRetryBaseMs: 2000,
  maxFetchAttempts: 4,
  proxiedPlayback: true,
  showAudioFiles: false,
  pageSize: "1000",
  defaultSubLang: "en",
  tokenTtl: 3000,
  listCacheTtl: 300,
  metaCacheTtl: 600,
  itemsPerCatalogPage: 1000,
  concurrentRequests: 20,
  maxFilesToFetch: 5000,
  kvCacheEnabled: true,
  kvCacheTtl: 86400, // 24 hours
  upstashRedisRestUrl: process.env.UPSTASH_REDIS_REST_URL,
  upstashRedisRestToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  hmacSecret: process.env.DOWNLOAD_TOKEN_SECRET || 'CHANGE_THIS_SECRET_IN_PRODUCTION',
};

// ========= SERVICE_ACCOUNTS (Loaded from Environment Variable) =========
let SERVICE_ACCOUNTS = [];
try {
    if (process.env.GOOGLE_SERVICE_ACCOUNTS_JSON) {
        SERVICE_ACCOUNTS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNTS_JSON);
    }
} catch (e) {
    console.error("Failed to parse GOOGLE_SERVICE_ACCOUNTS_JSON:", e.message);
}

if (!SERVICE_ACCOUNTS || SERVICE_ACCOUNTS.length === 0) {
  console.error('WARNING: SERVICE_ACCOUNTS is empty because the GOOGLE_SERVICE_ACCOUNTS_JSON environment variable is not set or is invalid. The addon will not be able to access Google Drive.');
}

// ========= HEADERS / API / CONSTANTS =========
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS,POST",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "public, max-age=300"
};

const API = {
  DRIVE_FILES: "https://content.googleapis.com/drive/v3/files",
  DRIVE_FILE: (id, fields = "*") =>
    `https://content.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
  DRIVE_MEDIA: (id) =>
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
  TOKEN: "https://oauth2.googleapis.com/token",
};

const FOLDER_MIME = "application/vnd.google-apps.folder";

// ========== Safe JSON Response Helper ==========
function safeJsonResponse(res, data, status = 200) {
  try {
    return res.status(status).set(HEADERS).json(data);
  } catch (error) {
    console.error('JSON response error:', error);
    return res.status(500).set(HEADERS).json({ error: "Internal server error" });
  }
}

// ========== Safe ID Extraction Helper ==========
function extractId(idParam, prefix) {
  try {
    if (!idParam || typeof idParam !== 'string') {
      return null;
    }
    let decoded = decodeURIComponent(idParam);
    if (decoded.startsWith(prefix + ":")) {
      return decoded.split(":")[1];
    }
    if (decoded.match(/^[a-zA-Z0-9_-]{25,}/)) {
      return decoded;
    }
    return null;
  } catch (error) {
    console.error('ID extraction error:', error);
    return null;
  }
}

// ========== Improved Upstash Redis Cache ==========
class UpstashKVCache {
  constructor() {
    if (CONFIG.upstashRedisRestUrl && CONFIG.upstashRedisRestToken) {
      this.redis = new Redis({
        url: CONFIG.upstashRedisRestUrl,
        token: CONFIG.upstashRedisRestToken,
      });
      console.log('Upstash Redis cache initialized');
    } else {
      console.log('Upstash Redis not configured, using in-memory cache');
      this.redis = null;
      this.cache = new Map();
    }
  }

  async get(key) {
    try {
      if (this.redis) {
        const value = await this.redis.get(key);
        if (typeof value === 'string') {
          try {
            return JSON.parse(value);
          } catch (e) {
            return value;
          }
        }
        return value;
      } else {
        const v = this.cache.get(key);
        if (!v) return null;
        if (v.exp && Date.now() > v.exp) {
          this.cache.delete(key);
          return null;
        }
        return v.value;
      }
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  async put(key, value, ttl = CONFIG.kvCacheTtl) {
    try {
      if (this.redis) {
        await this.redis.setex(key, ttl, JSON.stringify(value));
      } else {
        const entry = { value, exp: Date.now() + ttl * 1000 };
        this.cache.set(key, entry);
      }
    } catch (error) {
      console.error('Cache put error:', error);
    }
  }

  async delete(key) {
    try {
      if (this.redis) {
        await this.redis.del(key);
      } else {
        this.cache.delete(key);
      }
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }
}

const kvCache = new UpstashKVCache();

// ========== Base64url helpers ==========
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromJson(obj) {
  const json = JSON.stringify(obj);
  return b64urlEncode(Buffer.from(json, 'utf8'));
}

function fmtSize(bytes) {
  if (!bytes || isNaN(bytes)) return "Unknown";
  const k = 1000, units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

// ========== JWT signing using Node crypto ==========
async function signJwtRS256(privateKeyPem, dataBuffer) {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(dataBuffer);
  sign.end();
  const sig = sign.sign(privateKeyPem, "base64");
  return Buffer.from(sig, "base64");
}

// ========== Service Account / Token flow ==========
const scope = "https://www.googleapis.com/auth/drive";
let saIndex = 0;
const tokenCache = new Map();

async function getActiveTokens(count = CONFIG.concurrentRequests) {
  if (!SERVICE_ACCOUNTS.length) {
    throw new Error("No service accounts configured");
  }

  const tokens = [];
  const maxTokens = Math.min(count, SERVICE_ACCOUNTS.length);

  for (let i = 0; i < maxTokens; i++) {
    const idx = (saIndex + i) % SERVICE_ACCOUNTS.length;
    const sa = SERVICE_ACCOUNTS[idx];
    const cached = tokenCache.get(sa.client_email);

    if (cached && cached.exp > Date.now() + 30 * 1000) {
      tokens.push({ token: cached.token, email: sa.client_email });
      continue;
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: sa.client_email,
        scope,
        aud: API.TOKEN,
        iat: now,
        exp: now + Math.min(CONFIG.tokenTtl, 3500),
      };

      const header = { alg: "RS256", typ: "JWT" };
      const unsigned = `${b64urlFromJson(header)}.${b64urlFromJson(claims)}`;
      const signature = await signJwtRS256(sa.private_key, Buffer.from(unsigned));
      const assertion = `${unsigned}.${b64urlEncode(signature)}`;
      
      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      });

      const r = await fetch(API.TOKEN, { method: "POST", body });

      if (!r.ok) {
        const errorText = await r.text();
        console.error(`Token generation failed: HTTP ${r.status} - ${errorText}`);
        throw new Error(`token http ${r.status}`);
      }

      const j = await r.json();
      if (!j.access_token) {
        console.error("No access_token in response:", j);
        throw new Error("no access_token");
      }

      const expAt = Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600 * 1000) - 60 * 1000;
      tokenCache.set(sa.client_email, { token: j.access_token, exp: expAt });
      tokens.push({ token: j.access_token, email: sa.client_email });
    } catch (e) {
      console.warn("Token generation failed for SA:", sa?.client_email, e.message || e);
      continue;
    }
  }

  if (tokens.length === 0) {
    throw new Error("All service accounts failed to obtain token");
  }
  saIndex = (saIndex + tokens.length) % SERVICE_ACCOUNTS.length;
  return tokens;
}

async function saAccessToken() {
  const tokens = await getActiveTokens(1);
  return tokens[0].token;
}

// ========== Improved withSaFetch ==========
async function withSaFetch(url, init = {}, opts = {}) {
  const maxAttempts = opts.maxAttempts || CONFIG.maxFetchAttempts;
  const timeoutMs = opts.timeoutMs || CONFIG.apiRequestTimeoutMs;

  if (!SERVICE_ACCOUNTS || SERVICE_ACCOUNTS.length === 0) {
    throw new Error('No service accounts configured');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let token;
    try {
        const tokens = await getActiveTokens(1);
        token = tokens[0].token;
    } catch (e) {
      console.warn('withSaFetch: unable to get token', e.message);
      await new Promise(res => setTimeout(res, CONFIG.fetchRetryBaseMs * (attempt + 1)));
      continue;
    }

    const headers = Object.assign({}, init.headers || {}, {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Mozilla/5.0 (compatible; Stremio-GDrive-Addon/1.0)',
    });

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(url, { ...init, headers, signal: controller.signal });
      clearTimeout(id);

      if (r.status === 429) {
        const retryAfterRaw = r.headers.get('Retry-After');
        const waitMs = (retryAfterRaw ? Number(retryAfterRaw) : Math.pow(2, attempt)) * 1000;
        console.log(`Rate limited, waiting ${waitMs}ms`);
        await new Promise(res => setTimeout(res, waitMs));
        continue;
      }
      return r;
    } catch (err) {
      clearTimeout(id);
      console.warn('withSaFetch error:', err.name === 'AbortError' ? 'timeout' : err.message);
      await new Promise(res => setTimeout(res, CONFIG.fetchRetryBaseMs * (attempt + 1)));
    }
  }

  throw new Error('withSaFetch: exhausted attempts');
}

async function gjson(url) {
  try {
    const r = await withSaFetch(url);
    if (!r.ok) {
      console.error(`API request failed: ${url} - ${r.status} ${r.statusText}`);
      return null;
    }
    return r.json();
  } catch (error) {
    console.error('gjson error:', error);
    return null;
  }
}

// ========== Google Drive listing functions ==========
async function listFiles(params) {
  try {
    const cacheKey = `listFiles:${JSON.stringify(params)}`;
    const cached = await kvCache.get(cacheKey);
    if (cached) return cached;

    let allFiles = [];
    let pageToken = null;

    do {
      const url = new URL(API.DRIVE_FILES);
      const currentParams = {
        corpora: "allDrives",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        pageSize: String(CONFIG.pageSize),
        ...params,
        ...(pageToken && { pageToken }),
      };
      url.search = new URLSearchParams(currentParams).toString();

      const r = await withSaFetch(url.toString());
      if (!r.ok) {
        if (r.status === 404) return { files: [] }; // Not found is not an error here
        throw new Error(`Drive API error: ${r.status}`);
      }
      
      const j = await r.json();
      allFiles = allFiles.concat(j.files || []);
      pageToken = j.nextPageToken;
    } while (pageToken && allFiles.length < CONFIG.maxFilesToFetch);
    
    const result = { files: allFiles };
    await kvCache.put(cacheKey, result, CONFIG.listCacheTtl);
    return result;
  } catch (error) {
    console.error('listFiles error:', error.message);
    return { files: [] };
  }
}

// ========== Meta Handler ==========
async function handleMeta(req, res) {
  try {
    const { type, id } = req.params;
    const cacheKey = `meta:${id}`;
    const cached = await kvCache.get(cacheKey);
    if (cached) return safeJsonResponse(res, cached);

    if (id.startsWith("gdrive-folder:")) {
      const folderId = extractId(id, "gdrive-folder");
      const folder = await gjson(API.DRIVE_FILE(folderId, "id,name,iconLink"));
      if (!folder) return safeJsonResponse(res, { error: "Folder not found" }, 404);

      const r = await listFiles({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "files(id,name,mimeType,thumbnailLink,createdTime,size,iconLink)",
        orderBy: "name",
      });

      const videos = await collectVideosRecursive(r.files || [], 1, folder.iconLink);
      const meta = { meta: { id, type: "series", name: folder.name, poster: "https://cdn-icons-png.flaticon.com/512/716/716784.png", videos } };
      await kvCache.put(cacheKey, meta, CONFIG.metaCacheTtl);
      return safeJsonResponse(res, meta);
    }

    const fileId = extractId(id, "gdrive");
    const file = await gjson(API.DRIVE_FILE(fileId, "id,name,size,thumbnailLink,createdTime,videoMediaMetadata"));
    if (!file) return safeJsonResponse(res, { error: "File not found" }, 404);

    const meta = { meta: {
      id, type: "movie", name: file.name, poster: file.thumbnailLink,
      description: `Size: ${fmtSize(parseInt(file.size))}`,
      runtime: file.videoMediaMetadata ? Math.round(parseInt(file.videoMediaMetadata.durationMillis) / 1000) + 's' : undefined,
    }};

    await kvCache.put(cacheKey, meta, CONFIG.metaCacheTtl);
    return safeJsonResponse(res, meta);
  } catch (error) {
    console.error("Meta handler error:", error);
    return safeJsonResponse(res, { error: "Internal server error" }, 500);
  }
}

async function collectVideosRecursive(files, seasonNum, folderIcon) {
    let videos = [];
    const videoFiles = files.filter(f => f.mimeType && f.mimeType.startsWith("video/"));
    videos.push(...videoFiles.map((file, index) => ({
      id: `gdrive:${file.id}`,
      title: file.name,
      season: seasonNum,
      episode: index + 1,
      released: file.createdTime,
      thumbnail: file.thumbnailLink || folderIcon,
    })));

    const folders = files.filter(f => f.mimeType === FOLDER_MIME);
    for (const folder of folders) {
        const season = detectSeasonNumber(folder.name) || seasonNum;
        const r = await listFiles({
          q: `'${folder.id}' in parents and trashed=false`,
          fields: "files(id,name,mimeType,thumbnailLink,createdTime,size,iconLink)",
          orderBy: "name",
        });
        videos.push(...await collectVideosRecursive(r.files || [], season, folder.iconLink));
    }
    return videos;
}

function detectSeasonNumber(name) {
    const match = name.match(/season\s*(\d+)/i);
    return match ? parseInt(match[1]) : null;
}

// ========== Catalog Handler ==========
async function handleCatalog(req, res) {
  try {
    const { type, id, search } = req.params;
    let metas = [];

    if (search) {
      const searchResult = await performSearch(search);
      metas = searchResult.results.map(result => ({
        id: result.id, type: "movie", name: result.name, poster: result.thumbnail,
      }));
    } else if (id.startsWith("gdrive-root:")) {
      const folderId = extractId(id, "gdrive-root");
      const r = await listFiles({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "files(id,name,mimeType,thumbnailLink,size,createdTime)",
        orderBy: "createdTime desc",
      });
      metas = (r.files || []).map(f => ({
        id: f.mimeType === FOLDER_MIME ? `gdrive-folder:${f.id}` : `gdrive:${f.id}`,
        type: f.mimeType === FOLDER_MIME ? "series" : "movie",
        name: f.name,
        poster: f.thumbnailLink || (f.mimeType === FOLDER_MIME ? "https://cdn-icons-png.flaticon.com/512/716/716784.png" : null),
      }));
    } else if (id === 'gdrive_list') {
        const r = await listFiles({
            q: "mimeType contains 'video/' and trashed=false",
            orderBy: "createdTime desc",
            pageSize: 50,
            fields: "files(id,name,thumbnailLink,createdTime,size)",
        });
        metas = (r.files || []).map(f => ({
            id: `gdrive:${f.id}`, type: "movie", name: f.name, poster: f.thumbnailLink,
        }));
    }

    return safeJsonResponse(res, { metas });
  } catch (error) {
    console.error("Catalog handler error:", error);
    return safeJsonResponse(res, { error: "Internal server error" }, 500);
  }
}

// ========== Stream Handler ==========
async function handleStream(req, res) {
  try {
    const { type, id } = req.params;
    const fileId = extractId(id, "gdrive");
    if (!fileId) return safeJsonResponse(res, { streams: [] }, 404);

    const file = await gjson(API.DRIVE_FILE(fileId, "id,name,size,mimeType"));
    if (!file || !file.mimeType.startsWith('video/')) return safeJsonResponse(res, { streams: [] }, 404);

    const accessToken = await saAccessToken();
    let stream = buildStream(file, accessToken);
    stream = await addSubtitles(stream, fileId);

    return safeJsonResponse(res, { streams: [stream] });
  } catch (error) {
    console.error('Stream handler error:', error);
    return safeJsonResponse(res, { streams: [] }, 500);
  }
}

function buildStream(file, accessToken) {
  const url = `${CONFIG.baseUrl.replace(/\/$/, '')}/playback/${file.id}`;
  return {
    url,
    title: file.name,
    name: "Google Drive (Proxied)",
    behaviorHints: {
      proxied: true,
      videoSize: parseInt(file.size),
      filename: file.name,
      proxyHeaders: { request: { Authorization: `Bearer ${accessToken}` } },
    },
  };
}

async function addSubtitles(stream, fileId) {
    const pf = await gjson(API.DRIVE_FILE(fileId, "parents"));
    if (!pf?.parents?.[0]) return stream;
    const pid = pf.parents[0];
    
    const res = await listFiles({
      q: `'${pid}' in parents and trashed=false and (mimeType='text/vtt' or mimeType='application/x-subrip')`,
      fields: "files(id,name)"
    });
    
    stream.subtitles = (res.files || []).map(s => ({
      url: `${CONFIG.baseUrl.replace(/\/$/, '')}/subtitles/${s.id}`,
      lang: guessLang(s.name),
    }));

    return stream;
}

function guessLang(name) {
    const match = name.match(/\.([a-z]{2}(?:-[A-Z]{2})?)\.(srt|vtt)$/i);
    return match ? match[1] : CONFIG.defaultSubLang;
}

// ========== Search Function ==========
async function performSearch(searchQuery) {
    const q = buildBaseSearchQuery(decodeURIComponent(searchQuery));
    const r = await listFiles({ q, fields: "files(id,name,mimeType,thumbnailLink,size)" });
    return { results: (r.files || []).map(file => ({
        id: file.mimeType === FOLDER_MIME ? `gdrive-folder:${file.id}` : `gdrive:${file.id}`,
        name: file.name,
        type: file.mimeType === FOLDER_MIME ? "folder" : "file",
        thumbnail: file.thumbnailLink,
        size: file.size,
    }))};
}

function buildBaseSearchQuery(query) {
    query = query.replace(/'/g, "\\'");
    let q = `name contains '${query}' and trashed=false`;
    if (!CONFIG.showAudioFiles) {
        q += ` and (mimeType contains 'video/' or mimeType='${FOLDER_MIME}')`;
    }
    return q;
}


// ========== Playback Handler ==========
async function handlePlayback(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).send("File ID required");

    const accessToken = await saAccessToken();
    const driveUrl = API.DRIVE_MEDIA(id);
    
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (req.headers.range) headers.Range = req.headers.range;

    const driveRes = await fetch(driveUrl, { headers });
    if (!driveRes.ok) return res.status(driveRes.status).send(await driveRes.text());

    res.status(driveRes.status);
    driveRes.headers.forEach((value, name) => res.setHeader(name, value));
    driveRes.body.pipe(res);
  } catch (error) {
    console.error('Playback handler error:', error);
    res.status(500).send("Internal server error");
  }
}

// ========== Manifest Generator ==========
function getManifest(req) {
  const catalogs = [
    { type: "movie", id: "gdrive_list", name: "Recent Videos" },
    { type: "movie", id: "gdrive_search", name: "Search", extra: [{ name: "search", isRequired: true }] }
  ];

  CONFIG.rootFolders.forEach((folder) => {
    catalogs.push({ type: "movie", id: `gdrive-root:${folder.id}`, name: folder.name });
  });

  return {
    id: "community.gdrive.v105",
    version: "1.0.5",
    name: CONFIG.addonName,
    description: "Google Drive addon v1.0.5 - Securely loads service accounts from environment variables.",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Google_Drive_icon_%282020%29.svg/2295px-Google_Drive_icon_%282020%29.svg.png",
    background: "https://i.imgur.com/5QzA2cP.png",
    types: ["movie", "series"],
    catalogs,
    resources: ["stream", "meta", "catalog"],
    idPrefixes: ["gdrive"],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

// ========== Express Routes ==========
app.get("/", (req, res) => safeJsonResponse(res, getManifest(req)));
app.get("/manifest.json", (req, res) => safeJsonResponse(res, getManifest(req)));
app.get("/catalog/:type/:id.json", handleCatalog);
app.get("/catalog/:type/:id/search=:search.json", handleCatalog);
app.get("/meta/:type/:id.json", handleMeta);
app.get("/stream/:type/:id.json", handleStream);
app.get("/playback/:id", handlePlayback);

app.get("/health", (req, res) => {
  safeJsonResponse(res, { 
    status: "OK", 
    timestamp: new Date().toISOString(),
    version: "1.0.5",
    serviceAccounts: SERVICE_ACCOUNTS.length,
    proxiedPlayback: CONFIG.proxiedPlayback,
  });
});

// ========== Start Server ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 GDrive Stremio Addon v1.0.5 running on port ${PORT}`);
  console.log(`📝 Service Accounts configured: ${SERVICE_ACCOUNTS.length}`);
});

