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
      const webPath = '/' + path.relative('dist', fullPath).replace(/\\/g, '/');
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
const urlsToCache = ${JSON.stringify(['/', ...distFiles], null, 2)};

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

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
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
          
          return response;
        });
      })
  );
});`;

// Write service worker to dist directory
fs.writeFileSync('dist/sw.js', swContent);

// Also write to public directory for dev mode
fs.writeFileSync('public/sw.js', swContent);

console.log('Service worker generated with', distFiles.length, 'assets');