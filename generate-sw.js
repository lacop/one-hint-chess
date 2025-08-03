// Hacky but it works - we run this at build time to get list of all
// the files in `dist/` that should be precached for the app to work offline.
// There are libraries / vite plugins for this but getting those to work is a pain.

const fs = require('fs');
const path = require('path');

function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!fs.existsSync(dirPath)) {
    return arrayOfFiles;
  }

  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else if (!file.endsWith('.nnue')) {
      // Convert to web path (relative to dist root)
      const webPath = '/one-hint-chess/' + path.relative('dist', fullPath).replace(/\\/g, '/');
      arrayOfFiles.push(webPath);
    }
  });

  return arrayOfFiles;
}

// Get all files from dist directory
const distFiles = getAllFiles('dist');

// Generate service worker content
const swContent = `const CACHE_NAME = 'one-hint-chess-v1';

// All assets to precache
const urlsToCache = ${JSON.stringify(['/one-hint-chess/', ...distFiles], null, 2)};

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Required for SharedArrayBuffer support for stockfish wasm.
function responseWithHeaders(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
  newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

self.addEventListener('fetch', event => {
  if (event.request.url.endsWith('.nnue')) {
    // Skip caching for .nnue files, we store them in IndexedDB,
    // don't want to cache them twice.
    return;
  }
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return responseWithHeaders(response);
        }
        
        const fetchRequest = event.request.clone();
        
        return fetch(fetchRequest).then(response => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          
          const responseToCache = response.clone();
          
          caches.open(CACHE_NAME)
            .then(cache => {
              cache.put(event.request, responseToCache);
            });

          return responseWithHeaders(response);
        });
      })
  );
});`;

// Write service worker to dist directory
fs.writeFileSync('dist/sw.js', swContent);

// Also write to public directory for dev mode
fs.writeFileSync('public/sw.js', swContent);

console.log('Service worker generated with', distFiles.length, 'assets');