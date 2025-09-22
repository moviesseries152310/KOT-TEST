Stremio Google Drive Addon - README
Overview
A high-performance Stremio addon that allows you to stream content directly from your Google Drive. This addon features advanced caching with Upstash Redis, intelligent folder organization, and efficient pagination.

Features
🚀 High Performance: Optimized for Render with efficient caching and pagination

🔍 Smart Search: Advanced search functionality with relevance scoring

📁 Folder Support: Browse through Google Drive folders seamlessly

🎬 Video Streaming: Direct streaming of video content from Google Drive

💾 Upstash Caching: Redis-based caching for improved performance

📱 Stremio Integration: Full compatibility with Stremio desktop and mobile apps

🔄 Auto-Sorting: Content automatically sorted by creation date (newest first)
Setup Instructions
Prerequisites
Node.js 16.0.0 or higher

Google Service Account with Drive API access

Upstash Redis account (optional but recommended)

Stremio application installed

Installation
Clone or download this repository

Install dependencies:

bash
npm install
Configure your Google Service Account:

Create a service account in Google Cloud Console

Enable the Drive API

Add the service account email to your Google Drive sharing

Add your service account credentials to the SERVICE_ACCOUNTS array in index.js

Set up environment variables (optional for Upstash):

bash
# Create a .env file with:
UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
Start the server:

bash
npm start
For development with auto-restart:

bash
npm run dev
Configuration
Edit the CONFIG object in index.js to customize:

Root Folders: Add your Google Drive folder IDs and names

Caching: Adjust cache TTL settings

Pagination: Modify page sizes for optimal performance

Base URL: Set your Render deployment URL

Deployment to Render
Create a new Web Service on Render

Connect your GitHub repository or upload files manually

Set the following environment variables in Render dashboard:

UPSTASH_REDIS_REST_URL: Your Upstash Redis REST URL

UPSTASH_REDIS_REST_TOKEN: Your Upstash Redis REST token

Deploy the service

Adding to Stremio
Get your deployment URL (e.g., https://your-app.onrender.com)

In Stremio, go to Addons → Community Addons → Enter URL

Paste your deployment URL and click "Install"

Folder Structure
The addon organizes content based on your Google Drive structure:

Root Folders: Defined in the configuration

Subfolders: Automatically detected and browsable

Season Detection: Automatically detects season folders (e.g., "Season 1")

Non-Season Folders: Uses actual folder names when no season is detected

Troubleshooting
Common Issues
"Upstash Redis not configured" message

Solution: Set Upstash environment variables or ignore if using in-memory cache

"No service accounts configured" error

Solution: Add your Google Service Account credentials to the SERVICE_ACCOUNTS array

Content not appearing

Solution: Ensure your service account has access to the Google Drive folders

Performance issues

Solution: Consider adding more service accounts for better rate limiting handling

Logs
Check the console output for detailed error messages and debugging information.

Support
For issues and questions:

Check the troubleshooting section above

Ensure your configuration is correct

Verify your Google Service Account has proper permissions

License
MIT License - feel free to modify and distribute as needed.

Contributing
Contributions are welcome! Please feel free to submit pull requests or open issues for bugs and feature requests.

Changelog
v1.0.0
Initial release with Upstash Redis caching

Folder-based content organization

Season detection and real folder name support

Efficient pagination with end-of-folder indicators

Optimized for Render deployment

Note: This addon requires a Google Service Account with access to your Google Drive content. Ensure you follow Google's security best practices when setting up service accounts.
