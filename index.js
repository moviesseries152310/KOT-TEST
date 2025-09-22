// index.js - GDrive Addon v1.1.0 (Major Overhaul)
// Fixes streaming, large folder pagination, season/episode detection, and thumbnail handling.

require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { Redis } = require("@upstash/redis");
const timeout = require("connect-timeout");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(timeout("90s")); // Increased timeout for potentially long GDrive queries
app.use((req, res, next) => {
    if (!req.timedout) next();
});

// ========= CONFIGURATION =========
const CONFIG = {
    addonName: "GDrive Stremio",
    addonVersion: "1.1.0",
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
    apiRequestTimeoutMs: 45000,
    listCacheTtl: 300,
    metaCacheTtl: 1800, // Increased meta cache for series
    kvCacheTtl: 86400,
    pageSize: 1000, // Max page size for Drive API
};

// ========= OAUTH 2.0 CREDENTIALS =========
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    console.error("CRITICAL: Google OAuth credentials are not set.");
    process.exit(1);
}

// ========= CACHING AND API SETUP =========
const kvCache = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : { get: async () => null, set: async () => {}, del: async () => {} };

console.log(process.env.UPSTASH_REDIS_REST_URL ? "Upstash Redis cache initialized." : "Using mock in-memory cache.");

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
        console.log("Successfully refreshed access token.");
        return accessTokenCache.token;
    } catch (error) {
        console.error("Error refreshing access token:", error.message);
        accessTokenCache = { token: null, exp: 0 };
        throw error;
    }
}

// ========= API FETCH HELPERS =========
async function withAuthFetch(url, init = {}) {
    const accessToken = await getAccessToken();
    const headers = { ...init.headers, 'Authorization': `Bearer ${accessToken}` };
    return fetch(url, { ...init, headers });
}

async function gjson(url) {
    const r = await withAuthFetch(url);
    if (!r.ok) return null;
    return r.json();
}

async function listAllFiles(queryParams) {
    let allFiles = [];
    let pageToken = null;
    do {
        const url = new URL(API.DRIVE_FILES);
        const params = {
            ...queryParams,
            pageSize: CONFIG.pageSize,
            pageToken: pageToken || undefined
        };
        url.search = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
        
        const data = await gjson(url.toString());
        if (!data) break;

        if (data.files) allFiles = allFiles.concat(data.files);
        pageToken = data.nextPageToken;
    } while (pageToken);
    return allFiles;
}

// ========= UTILITIES =========
const fmtSize = (bytes) => (bytes ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : "Unknown");
const extractId = (id, prefix) => id.startsWith(prefix) ? id.split(':')[1] : id;
const FOLDER_MIME = "application/vnd.google-apps.folder";

const REGEX_SEASON = /S?(\d+)/i;
const REGEX_EPISODE = /E(\d+)/i;

// ========= MANIFEST =========
const getManifest = () => ({
    id: "community.gdrive.v110",
    version: CONFIG.addonVersion,
    name: CONFIG.addonName,
    description: "Stable Google Drive addon with full series support, subtitle integration, and robust playback.",
    logo: "https://i.imgur.com/8V5RVEk.png",
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "gdrive_recents", name: "Recent Videos" },
        ...CONFIG.rootFolders.map(f => ({ type: "series", id: `gdrive-root:${f.id}`, name: f.name })),
        { type: "movie", id: "gdrive_search", name: "Search", extra: [{ name: "search", isRequired: true }] }
    ],
    resources: ["stream", "meta", "catalog"],
    idPrefixes: ["gdrive"],
});

// ========= HANDLERS =========
async function handleCatalog(req, res) {
    const { id, search } = req.params;
    let metas = [];
    
    if (search) {
        const files = await listAllFiles({
            q: `name contains '${search.replace(/'/g, "\\'")}' and trashed=false`,
            fields: 'files(id,name,mimeType,thumbnailLink,size)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });
        metas = files.map(fileToMeta);
    } else if (id === "gdrive_recents") {
        const files = await listAllFiles({
            orderBy: 'createdTime desc',
            q: `mimeType contains 'video/' and trashed=false`,
            fields: 'files(id,name,mimeType,thumbnailLink,size,createdTime)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });
        metas = files.map(fileToMeta);
    } else if (id.startsWith("gdrive-root:") || id.startsWith("gdrive-folder:")) {
        const folderId = extractId(id, id.startsWith("gdrive-root:") ? "gdrive-root" : "gdrive-folder");
        const files = await listAllFiles({
            q: `'${folderId}' in parents and trashed=false`,
            fields: 'files(id,name,mimeType,thumbnailLink,size)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            orderBy: 'name'
        });
        metas = files.map(fileToMeta);
    }
    
    res.json({ metas });
}

async function handleMeta(req, res) {
    const { id } = req.params;
    const isFolder = id.startsWith('gdrive-folder:');
    const itemId = extractId(id, isFolder ? 'gdrive-folder' : 'gdrive');

    if (!itemId) return res.status(404).json({ err: 'Not Found' });
    
    const cacheKey = `meta:${id}`;
    const cached = await kvCache.get(cacheKey).catch(() => null);
    if (cached) return res.json({ meta: JSON.parse(cached) });

    let meta;
    if (isFolder) {
        const [folder, allContents] = await Promise.all([
            gjson(API.DRIVE_FILE(itemId, "id,name,thumbnailLink")),
            listAllFiles({ q: `'${itemId}' in parents and trashed=false`, fields: 'files(id,name,mimeType,createdTime,size,thumbnailLink)', orderBy: 'name', supportsAllDrives: true, includeItemsFromAllDrives: true })
        ]);
        if (!folder) return res.status(404).json({ err: 'Not Found' });
        
        const videos = allContents.filter(f => f.mimeType.startsWith('video/'));
        
        meta = {
            id, name: folder.name, type: 'series',
            poster: folder.thumbnailLink || "https://i.imgur.com/G4A4B1a.png",
            background: folder.thumbnailLink,
            videos: videos.map((file, index) => {
                const sMatch = file.name.match(REGEX_SEASON);
                const eMatch = file.name.match(REGEX_EPISODE);
                return {
                    id: `gdrive:${file.id}`,
                    title: file.name,
                    season: sMatch ? parseInt(sMatch[1]) : 1,
                    episode: eMatch ? parseInt(eMatch[1]) : index + 1,
                    released: file.createdTime,
                    thumbnail: file.thumbnailLink
                };
            })
        };
    } else {
        const file = await gjson(API.DRIVE_FILE(itemId, "id,name,size,thumbnailLink,createdTime,videoMediaMetadata"));
        if (!file) return res.status(404).json({ err: 'Not Found' });
        meta = {
            id, name: file.name, type: 'movie', poster: file.thumbnailLink,
            background: file.thumbnailLink, description: `Size: ${fmtSize(file.size)}`
        };
    }

    await kvCache.set(cacheKey, JSON.stringify(meta), { ex: CONFIG.metaCacheTtl });
    res.json({ meta });
}

async function handleStream(req, res) {
    const { id } = req.params;
    const fileId = extractId(id, 'gdrive:');
    if (!fileId) return res.status(404).json({ streams: [] });

    const [file, parentFolder] = await Promise.all([
        gjson(API.DRIVE_FILE(fileId, "id,name,size,parents")),
        gjson(API.DRIVE_FILE(fileId, "parents")).then(data => data && data.parents ? gjson(API.DRIVE_FILE(data.parents[0], "id")) : null)
    ]);
    
    if (!file) return res.status(404).json({ streams: [] });

    const subs = [];
    if (parentFolder) {
        const subFiles = await listAllFiles({ q: `'${parentFolder.id}' in parents and (name contains '.srt' or name contains '.vtt') and trashed=false`, fields: 'files(id,name)', supportsAllDrives: true, includeItemsFromAllDrives: true });
        for (const sub of subFiles) {
            const lang = sub.name.match(/\.([a-z]{2})\.(srt|vtt)$/)?.[1] || 'en';
            subs.push({
                id: `gdrive:${sub.id}`,
                url: `${CONFIG.baseUrl}/subtitles/${sub.id}.srt`,
                lang: lang
            });
        }
    }
    
    const stream = {
        url: `${CONFIG.baseUrl}/playback/${file.id}`,
        title: `${file.name}\n${fmtSize(file.size)}`,
        behaviorHints: { proxied: true, videoSize: parseInt(file.size) || undefined },
        subtitles: subs
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
        const headers = { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': req.get('User-Agent') };
        if (range) headers.Range = range;

        const driveRes = await fetch(driveUrl, { headers });

        if (!driveRes.ok) return res.status(driveRes.status).send(await driveRes.text());
        
        res.status(driveRes.status);
        driveRes.headers.forEach((v, n) => res.setHeader(n, v));
        driveRes.body.pipe(res);
    } catch (error) {
        console.error('Playback handler error:', error);
        res.status(500).send("Internal server error");
    }
}

async function handleSubtitles(req, res) {
    const { id } = req.params;
    const accessToken = await getAccessToken();
    const driveUrl = API.DRIVE_MEDIA(id);
    const driveRes = await fetch(driveUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (!driveRes.ok) return res.status(driveRes.status).send(await driveRes.text());
    res.setHeader('Content-Type', 'text/plain');
    driveRes.body.pipe(res);
}

const fileToMeta = (file) => ({
    id: file.mimeType === FOLDER_MIME ? `gdrive-folder:${file.id}` : `gdrive:${file.id}`,
    type: file.mimeType === FOLDER_MIME ? 'series' : 'movie',
    name: file.name,
    poster: file.thumbnailLink || (file.mimeType === FOLDER_MIME ? "https://i.imgur.com/G4A4B1a.png" : null),
    posterShape: 'poster',
    description: file.mimeType !== FOLDER_MIME ? `Size: ${fmtSize(file.size)}` : ''
});


// ========= ROUTES =========
app.get("/manifest.json", (req, res) => res.json(getManifest()));
app.get('/', (req, res) => res.redirect('/manifest.json'));

app.get('/catalog/:type/:id.json', handleCatalog);
app.get('/catalog/:type/:id/search=:search.json', handleCatalog);
app.get('/meta/:type/:id.json', handleMeta);
app.get('/stream/:type/:id.json', handleStream);
app.get('/playback/:id', handlePlayback);
app.get('/subtitles/:id.srt', handleSubtitles);


// ========= SERVER START =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 GDrive Addon v${CONFIG.addonVersion} running on port ${PORT}`);
});

