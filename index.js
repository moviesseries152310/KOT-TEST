// index.js - GDrive Addon v1.0.9 (Deployment Fix)
// Uses OAuth 2.0 and includes all necessary dependencies.

require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { Redis } = require("@upstash/redis");
const timeout = require("connect-timeout");
const { AbortController } = require('abort-controller');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(timeout("60s"));
app.use((req, res, next) => {
    if (!req.timedout) next();
});

// ========= CONFIGURATION =========
const CONFIG = {
    addonName: "GDrive v1.0.9",
    baseUrl: process.env.BASE_URL || "http://127.0.0.1:3000",
    rootFolders: [
        { id: "1X18vIlx0I74wcXLYFYkKs1Xo_vW9jw6i", name: "Hindi Dubbed" },
        { id: "1-NwN-Rxwwaxe9baXu26owKMXP5urzLQ4", name: "Crunchyroll" },
        { id: "1-qKf0GOsySvIZMpMjE6-SwcGe40opFGM", name: "Bollywood" },
        { id: "18llWh5xMxb8J3FcJDCYX3RXlrcG7zZKs", name: "Animated Movies" },
        { id: "15No1zGvyaQ4ZeEJK7naXmVsigKXRHorL", name: "New Web Series" },
        { id: "1vOxJULycYIir_fklIzT9stfSsu6_m99o", name: "Hindi Web Series" },
        { id: "1kNiheEQTfld1wpaYsMsZ8O6cLXHSTIKN", name: "Web Series" },
    ],
    proxiedPlayback: true,
    apiRequestTimeoutMs: 30000,
    listCacheTtl: 300,
    metaCacheTtl: 600,
    kvCacheTtl: 86400,
};

// ========= OAUTH 2.0 CREDENTIALS =========
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    console.error("CRITICAL: Google OAuth credentials are not set in environment variables.");
}

// ========= CACHING AND API SETUP =========
const kvCache = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : { get: async () => null, setex: async () => {} }; // Fallback to a mock cache

if (process.env.UPSTASH_REDIS_REST_URL) {
    console.log("Upstash Redis cache initialized.");
} else {
    console.log("Using in-memory cache (not persistent).");
}

const API = {
    DRIVE_FILES: "https://www.googleapis.com/drive/v3/files",
    DRIVE_FILE: (id, fields = "*") => `https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
    DRIVE_MEDIA: (id) => `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
    TOKEN: "https://oauth2.googleapis.com/token",
};

let accessTokenCache = { token: null, exp: 0 };

// ========= AUTHENTICATION FLOW =========
async function getAccessToken() {
    if (accessTokenCache.token && Date.now() < accessTokenCache.exp) {
        return accessTokenCache.token;
    }

    try {
        const response = await fetch(API.TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                refresh_token: GOOGLE_REFRESH_TOKEN,
                grant_type: 'refresh_token'
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error_description || 'Failed to refresh token');

        accessTokenCache = {
            token: data.access_token,
            exp: Date.now() + (data.expires_in * 1000) - 60000
        };
        return accessTokenCache.token;
    } catch (error) {
        console.error("Error refreshing access token:", error.message);
        accessTokenCache = { token: null, exp: 0 };
        throw error;
    }
}

// ========= API FETCH HELPERS =========
async function withAuthFetch(url, init = {}) {
    try {
        const accessToken = await getAccessToken();
        const headers = { ...init.headers, 'Authorization': `Bearer ${accessToken}` };
        return await fetch(url, { ...init, headers });
    } catch {
        return new Response("Authentication failed", { status: 500 });
    }
}

async function gjson(url) {
    const r = await withAuthFetch(url);
    if (!r.ok) return null;
    return r.json();
}

// ========= UTILITY FUNCTIONS =========
function fmtSize(bytes) {
  if (!bytes || isNaN(bytes)) return "Unknown";
  const k = 1000, units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

function extractId(idParam, prefix) {
    if (!idParam || typeof idParam !== 'string') return null;
    let decoded = decodeURIComponent(idParam);
    if (decoded.startsWith(prefix + ":")) return decoded.split(":")[1];
    if (decoded.match(/^[a-zA-Z0-9_-]{25,}/)) return decoded;
    return null;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

function fileToMeta(file) {
    const isFolder = file.mimeType === FOLDER_MIME;
    return {
        id: isFolder ? `gdrive-folder:${file.id}` : `gdrive:${file.id}`,
        type: isFolder ? 'series' : 'movie',
        name: file.name,
        poster: isFolder ? "https://i.imgur.com/G4A4B1a.png" : file.thumbnailLink,
        description: isFolder ? "Folder" : `Size: ${fmtSize(file.size)}`
    };
}


// ========= MANIFEST =========
function getManifest() {
    return {
        id: "community.gdrive.v109",
        version: "1.0.9",
        name: CONFIG.addonName,
        description: "Google Drive addon using OAuth 2.0. Streams movies and series directly from your Google Drive.",
        logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Google_Drive_icon_%282020%29.svg/2295px-Google_Drive_icon_%282020%29.svg.png",
        types: ["movie", "series"],
        catalogs: [
            { type: "movie", id: "gdrive_recents", name: "Recent Videos" },
            ...CONFIG.rootFolders.map(folder => ({
                type: "movie",
                id: `gdrive-root:${folder.id}`,
                name: folder.name
            })),
            { type: "movie", id: "gdrive_search", name: "Search", extra: [{ name: "search", isRequired: true }] }
        ],
        resources: ["stream", "meta", "catalog"],
        idPrefixes: ["gdrive"],
    };
}

// ========= ROUTE HANDLERS (Full Implementation) =========
async function handleCatalog(req, res) {
    const { id, search } = req.params;
    let metas = [];
    const cacheKey = `catalog:${search ? `search:${search}` : id}`;
    
    const cached = await kvCache.get(cacheKey);
    if (cached) return res.json({ metas: cached });

    if (search) {
        const r = await gjson(`${API.DRIVE_FILES}?q=name contains '${search}' and trashed=false&fields=files(id,name,mimeType,thumbnailLink,size)`);
        if(r && r.files) metas = r.files.map(fileToMeta);
    } else if (id === "gdrive_recents") {
        const r = await gjson(`${API.DRIVE_FILES}?orderBy=createdTime desc&pageSize=100&q=mimeType contains 'video/' and trashed=false&fields=files(id,name,mimeType,thumbnailLink,size,createdTime)`);
        if(r && r.files) metas = r.files.map(fileToMeta);
    } else if (id.startsWith("gdrive-root:") || id.startsWith("gdrive-folder:")) {
        const folderId = extractId(id, id.startsWith("gdrive-root:") ? "gdrive-root" : "gdrive-folder");
        const r = await gjson(`${API.DRIVE_FILES}?q='${folderId}' in parents and trashed=false&fields=files(id,name,mimeType,thumbnailLink,size)`);
        if(r && r.files) metas = r.files.map(fileToMeta);
    }
    
    if (metas.length > 0) {
        await kvCache.setex(cacheKey, CONFIG.listCacheTtl, JSON.stringify(metas));
    }

    res.json({ metas });
}

async function handleMeta(req, res) {
    const { id } = req.params;
    const isFolder = id.startsWith('gdrive-folder:');
    const itemId = extractId(id, isFolder ? 'gdrive-folder' : 'gdrive');

    if (!itemId) return res.status(404).json({ err: 'Not Found' });
    
    const cacheKey = `meta:${id}`;
    const cached = await kvCache.get(cacheKey);
    if (cached) return res.json({ meta: JSON.parse(cached) });

    let meta;
    if (isFolder) {
        const folder = await gjson(API.DRIVE_FILE(itemId, "id,name"));
        if (!folder) return res.status(404).json({ err: 'Not Found' });
        const filesRes = await gjson(`${API.DRIVE_FILES}?q='${itemId}' in parents and trashed=false and mimeType contains 'video/'&fields=files(id,name,createdTime,size,thumbnailLink,videoMediaMetadata)`);
        
        meta = {
            id,
            name: folder.name,
            type: 'series',
            poster: "https://i.imgur.com/G4A4B1a.png",
            videos: filesRes.files.map((file, index) => ({
                id: `gdrive:${file.id}`,
                title: file.name,
                season: 1,
                episode: index + 1,
                released: file.createdTime,
                thumbnail: file.thumbnailLink,
                streams: [{ url: `${CONFIG.baseUrl}/playback/${file.id}`, title: "GDrive Stream" }]
            }))
        };
    } else {
        const file = await gjson(API.DRIVE_FILE(itemId, "id,name,size,thumbnailLink,createdTime,videoMediaMetadata"));
        if (!file) return res.status(404).json({ err: 'Not Found' });

        meta = {
            id: `gdrive:${file.id}`,
            name: file.name,
            type: 'movie',
            poster: file.thumbnailLink,
            background: file.thumbnailLink,
            description: `Size: ${fmtSize(file.size)}`
        };
    }

    await kvCache.setex(cacheKey, CONFIG.metaCacheTtl, JSON.stringify(meta));
    res.json({ meta });
}

async function handleStream(req, res) {
    const { id } = req.params;
    const fileId = extractId(id, 'gdrive');
    if (!fileId) return res.status(404).json({ streams: [] });
    
    const file = await gjson(API.DRIVE_FILE(fileId, "id,name,size"));
    if (!file) return res.status(404).json({ streams: [] });
    
    const stream = {
        url: `${CONFIG.baseUrl}/playback/${file.id}`,
        title: `GDrive`,
        behaviorHints: {
            proxied: true,
            videoSize: file.size ? parseInt(file.size) : undefined,
            filename: file.name
        }
    };
    
    res.json({ streams: [stream] });
}

async function handlePlayback(req, res) {
    try {
        const fileId = req.params.id;
        if (!fileId) return res.status(400).send("File ID required");

        const accessToken = await getAccessToken();
        const driveUrl = API.DRIVE_MEDIA(fileId);
        
        const range = req.headers.range;
        const headers = { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': req.headers['user-agent'] };
        if (range) headers.Range = range;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.apiRequestTimeoutMs);

        const driveRes = await fetch(driveUrl, { headers, signal: controller.signal });
        clearTimeout(timeoutId);

        if (!driveRes.ok) {
            return res.status(driveRes.status).send(await driveRes.text());
        }

        res.status(driveRes.status);
        driveRes.headers.forEach((value, name) => {
            // Let the client handle content-length if chunked
            if (name.toLowerCase() !== 'transfer-encoding') {
                 res.setHeader(name, value);
            }
        });
        driveRes.body.pipe(res);

    } catch (error) {
        if (error.name !== 'AbortError') {
             console.error('Playback handler error:', error);
             res.status(500).send("Internal server error");
        }
    }
}


// ========= ROUTES =========
app.get("/manifest.json", (req, res) => res.json(getManifest()));
app.get('/', (req, res) => res.redirect('/manifest.json'));

app.get('/catalog/:type/:id.json', handleCatalog);
app.get('/catalog/:type/:id/search=:search.json', handleCatalog);
app.get('/meta/:type/:id.json', handleMeta);
app.get('/stream/:type/:id.json', handleStream);
app.get('/playback/:id', handlePlayback);

// ========= SERVER START =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 GDrive Stremio Addon v1.0.9 running on port ${PORT}`);
    console.log(`🔒 Using OAuth 2.0 (Client ID) authentication method.`);
});

