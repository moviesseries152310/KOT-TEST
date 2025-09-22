// index.js - GDrive Addon v1.1.1 (Stability and Features Update)
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
app.use(timeout("120s")); // Increased timeout for large GDrive queries
app.use((req, res, next) => {
    if (!req.timedout) next();
});

// ========= CONFIGURATION =========
const CONFIG = {
    addonName: "GDrive Stremio",
    addonVersion: "1.1.1",
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
    apiRequestTimeoutMs: 60000,
    listCacheTtl: 300,
    metaCacheTtl: 1800,
    pageSize: 1000, // Max page size for Drive API
};

// ========= OAUTH 2.0 CREDENTIALS =========
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    console.error("CRITICAL: Google OAuth credentials are not set in environment variables.");
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
            pageToken: pageToken || undefined,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
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
const fmtSize = (bytes) => (bytes ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` : "Unknown");
const extractId = (id, prefix) => id.startsWith(prefix) ? id.split(':')[1] : id;
const FOLDER_MIME = "application/vnd.google-apps.folder";

function parseSeasonEpisode(name) {
    const patterns = [
        /S(\d+)[._ ]?E(\d+)/i,
        /Season[._ ]?(\d+)[._ ]?Episode[._ ]?(\d+)/i,
        /(\d+)x(\d+)/i,
        /\[(\d+)\.(\d+)\]/i
    ];
    for (const pattern of patterns) {
        const match = name.match(pattern);
        if (match) {
            return { season: parseInt(match[1]), episode: parseInt(match[2]) };
        }
    }
    // Fallback for names like "01. My Episode"
    const simpleMatch = name.match(/^(\d+)\./);
    if (simpleMatch) {
        return { season: 1, episode: parseInt(simpleMatch[1]) };
    }
    return null;
}

const fileToMeta = (file) => ({
    id: file.mimeType === FOLDER_MIME ? `gdrive-folder:${file.id}` : `gdrive:${file.id}`,
    type: file.mimeType === FOLDER_MIME ? 'series' : 'movie',
    name: file.name,
    poster: file.thumbnailLink || (file.mimeType === FOLDER_MIME ? "https://i.imgur.com/G4A4B1a.png" : null),
    posterShape: 'poster',
    description: file.mimeType !== FOLDER_MIME ? `Size: ${fmtSize(file.size)}` : ''
});

// ========= MANIFEST =========
const getManifest = () => ({
    id: "community.gdrive.v111",
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
    const cacheKey = `catalog:${search ? `search:${search}` : id}`;
    try {
        const cached = await kvCache.get(cacheKey);
        if (cached) return res.json({ metas: JSON.parse(cached) });
    } catch (e) { console.error("Redis GET error:", e); }

    let files = [];
    if (search) {
        files = await listAllFiles({
            q: `name contains '${search.replace(/'/g, "\\'")}' and trashed=false`,
            fields: 'files(id,name,mimeType,thumbnailLink,size)',
        });
    } else {
        const folderId = id === "gdrive_recents" ? 'root' : extractId(id, id.startsWith("gdrive-root:") ? "gdrive-root" : "gdrive-folder");
        const orderBy = id === "gdrive_recents" ? 'createdTime desc' : 'name';
        const q = id === "gdrive_recents" ? `mimeType contains 'video/' and trashed=false` : `'${folderId}' in parents and trashed=false`;
        files = await listAllFiles({ q, orderBy, fields: 'files(id,name,mimeType,thumbnailLink,size,createdTime)' });
    }
    
    const metas = files.map(fileToMeta);
    if (metas.length > 0) {
        try {
            await kvCache.set(cacheKey, JSON.stringify(metas), { ex: CONFIG.listCacheTtl });
        } catch (e) { console.error("Redis SET error:", e); }
    }
    res.json({ metas });
}

async function handleMeta(req, res) {
    const { id } = req.params;
    const isFolder = id.startsWith('gdrive-folder:') || id.startsWith('gdrive-root:');
    const prefix = id.startsWith('gdrive-root:') ? 'gdrive-root' : (isFolder ? 'gdrive-folder' : 'gdrive');
    const itemId = extractId(id, prefix);

    if (!itemId) return res.status(404).json({ err: 'Not Found' });
    
    const cacheKey = `meta:${id}`;
    try {
        const cached = await kvCache.get(cacheKey);
        if (cached) return res.json({ meta: JSON.parse(cached) });
    } catch(e) { console.error("Redis GET error:", e); }

    let meta;
    if (isFolder) {
        const [folder, allContents] = await Promise.all([
            gjson(API.DRIVE_FILE(itemId, "id,name")),
            listAllFiles({ q: `'${itemId}' in parents and trashed=false`, fields: 'files(id,name,mimeType,createdTime,size,thumbnailLink)', orderBy: 'name' })
        ]);
        if (!folder) return res.status(404).json({ err: 'Not Found' });
        
        const videos = allContents.filter(f => f.mimeType && f.mimeType.startsWith('video/'));
        const firstVideoWithThumb = videos.find(v => v.thumbnailLink);
        
        meta = {
            id, name: folder.name, type: 'series',
            poster: firstVideoWithThumb ? firstVideoWithThumb.thumbnailLink : "https://i.imgur.com/G4A4B1a.png",
            background: firstVideoWithThumb ? firstVideoWithThumb.thumbnailLink.replace(/=s\d+/, '=s1280') : null,
            videos: videos.map((file, index) => {
                const parsed = parseSeasonEpisode(file.name);
                return {
                    id: `gdrive:${file.id}`,
                    title: file.name,
                    season: parsed ? parsed.season : 1,
                    episode: parsed ? parsed.episode : index + 1,
                    released: file.createdTime,
                    thumbnail: file.thumbnailLink,
                };
            }).sort((a, b) => a.season - b.season || a.episode - b.episode)
        };
    } else {
        const file = await gjson(API.DRIVE_FILE(itemId, "id,name,size,thumbnailLink,createdTime"));
        if (!file) return res.status(404).json({ err: 'Not Found' });
        meta = {
            id, name: file.name, type: 'movie', poster: file.thumbnailLink,
            background: file.thumbnailLink ? file.thumbnailLink.replace(/=s\d+/, '=s1280') : null, 
            description: `Size: ${fmtSize(file.size)}`
        };
    }

    try {
        await kvCache.set(cacheKey, JSON.stringify(meta), { ex: CONFIG.metaCacheTtl });
    } catch(e) { console.error("Redis SET error:", e); }
    res.json({ meta });
}

async function handleStream(req, res) {
    const { id } = req.params;
    const fileId = extractId(id, 'gdrive:');
    if (!fileId) return res.status(404).json({ streams: [] });

    const file = await gjson(API.DRIVE_FILE(fileId, "id,name,size,parents"));
    if (!file) return res.status(404).json({ streams: [] });
    
    let subs = [];
    try {
        if (file.parents && file.parents[0]) {
            const subFiles = await listAllFiles({ q: `'${file.parents[0]}' in parents and (name contains '.srt' or name contains '.vtt') and trashed=false`, fields: 'files(id,name)' });
            subs = subFiles
                .filter(sub => sub.name.toLowerCase().startsWith(file.name.toLowerCase().replace(/\.[^/.]+$/, "")))
                .map(sub => {
                    const langMatch = sub.name.match(/\.([a-z]{2})\.(srt|vtt)$/);
                    return {
                        id: `gdrive-sub:${sub.id}`,
                        url: `${CONFIG.baseUrl}/subtitles/${sub.id}.srt`,
                        lang: langMatch ? langMatch[1] : 'en'
                    };
                });
        }
    } catch (e) {
        console.error("Subtitle search failed:", e);
    }
    
    res.json({
        streams: [{
            url: `${CONFIG.baseUrl}/playback/${file.id}`,
            title: `GDrive Stream\n${fmtSize(file.size)}`,
            behaviorHints: {
                proxied: true,
                videoSize: parseInt(file.size) || undefined,
                filename: file.name,
            },
            subtitles: subs,
        }]
    });
}


async function handlePlayback(req, res) {
    try {
        const fileId = req.params.id;
        if (!fileId) return res.status(400).send("File ID required");

        const accessToken = await getAccessToken();
        const driveUrl = API.DRIVE_MEDIA(fileId);
        
        const range = req.headers.range;
        const headers = { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': req.get('User-Agent') || 'Stremio' };
        if (range) headers.Range = range;

        const driveRes = await fetch(driveUrl, { headers });
        if (!driveRes.ok) return res.status(driveRes.status).send(await driveRes.text());
        
        res.status(driveRes.status);
        driveRes.headers.forEach((v, n) => res.setHeader(n, v));
        driveRes.body.pipe(res);
    } catch (error) {
        console.error('Playback handler error:', error);
        res.status(500).send("Internal Server Error");
    }
}

async function handleSubtitles(req, res) {
    const { id } = req.params;
    const fileId = id.replace('.srt','');
    const accessToken = await getAccessToken();
    const driveUrl = API.DRIVE_MEDIA(fileId);
    const driveRes = await fetch(driveUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (!driveRes.ok) return res.status(driveRes.status).send(await driveRes.text());
    res.setHeader('Content-Type', 'text/plain;charset=utf-8');
    driveRes.body.pipe(res);
}

// ========= ROUTES =========
app.get("/manifest.json", (req, res) => res.json(getManifest()));
app.get('/', (req, res) => res.redirect('/manifest.json'));

app.get('/catalog/:type/:id.json', handleCatalog);
app.get('/catalog/:type/:id/search=:search.json', handleCatalog);
app.get('/meta/:type/:id.json', handleMeta);
app.get('/stream/:type/:id.json', handleStream);
app.get('/playback/:id', handlePlayback);
app.get('/subtitles/:id', handleSubtitles);


// ========= SERVER START =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 GDrive Addon v${CONFIG.addonVersion} running on port ${PORT}`);
});

