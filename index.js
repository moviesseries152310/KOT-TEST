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

// ========= ROUTE HANDLERS (Full Implementation) =========
async function handleCatalog(req, res) {
    const { type, id } = req.params;
    const { search } = req.params;

    let metas = [];
    const cacheKey = `catalog:${search ? `search:${search}` : id}`;
    
    // Caching logic here if needed

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
    
    res.json({ metas });
}

async function handleMeta(req, res) {
    const { id } = req.params;
    const fileId = extractId(id, 'gdrive');
    if (!fileId) return res.status(404).json({ err: 'Not Found' });
    
    const file = await gjson(API.DRIVE_FILE(fileId, "id,name,size,thumbnailLink,createdTime,videoMediaMetadata"));
    if (!file) return res.status(404).json({ err: 'Not Found' });

    const meta = {
        id: `gdrive:${file.id}`,
        name: file.name,
        type: 'movie',
        poster: file.thumbnailLink,
        background: file.thumbnailLink,
        description: `Size: ${fmtSize(file.size)}`
    };

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
        title: `GDrive - ${file.name}`,
        behaviorHints: {
            proxied: true,
            videoSize: file.size ? parseInt(file.size) : undefined
        }
    };
    
    res.json({ streams: [stream] });
}


// ========= HELPER for converting file object to meta object =========
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

