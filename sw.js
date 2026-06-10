const BASE_URL = '/alist-music/'; 

const CACHE_VERSION = 'dmusic-static-v2';
const STATIC_ASSETS = [
    BASE_URL,
    `${BASE_URL}index.html`,
    `${BASE_URL}alist.js`,    
    `${BASE_URL}manifest.json`,
    `${BASE_URL}favicon.ico`
];

self.addEventListener('install', function(event) {
	event.waitUntil(caches.open(CACHE_VERSION).then(function(cache) {
		return cache.addAll(STATIC_ASSETS);
	}));
	self.skipWaiting();
});

self.addEventListener('activate', function(event) {
	event.waitUntil(Promise.all([
		caches.keys().then(function(keys) {
			return Promise.all(keys.filter(function(key) {
				return key !== CACHE_VERSION;
			}).map(function(key) {
				return caches.delete(key);
			}));
		}),
		self.clients.claim()
	]));
});

self.addEventListener('fetch', function(event) {
    if (event.request.method !== 'GET') return;
    
    const requestUrl = new URL(event.request.url);
    if (requestUrl.origin !== self.location.origin) return;

    event.respondWith(
        caches.match(event.request).then(function(cachedResponse) {
            if (cachedResponse) return cachedResponse;
            
            return fetch(event.request).then(function(networkResponse) {
                if (!networkResponse || networkResponse.status !== 200) return networkResponse;
                
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_VERSION).then(function(cache) {
                    cache.put(event.request, responseToCache);
                });
                return networkResponse;
            }).catch(function() {
                if (event.request.mode === 'navigate') {
                    return caches.match(`${BASE_URL}index.html`); 
                }
                return caches.match(event.request);
            });
        })
    );
});
