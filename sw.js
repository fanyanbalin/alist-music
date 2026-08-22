const CACHE_VERSION = 'alist-music-static-v10';
const STATIC_ASSETS = [
	'./',
	'./index.html',
	'./style.css?t=10',
	'./app-core.js?t=10',
	'./utils.js?t=10',
	'./alist.js?t=10',
	'./app.js?t=10',
	'./manifest.json',
	'./favicon.ico',
	'./icon-192.png',
	'./icon-512.png',
	'./vendor/fontawesome.min.css',
	'./vendor/vue.global.prod.js',
	'./vendor/pako.min.js',
	'./vendor/localforage.min.js',
	'./vendor/axios.min.js',
	'./vendor/md5.min.js',
	'./webfonts/fa-solid-900.woff2',
	'./webfonts/fa-regular-400.woff2',
	'./webfonts/fa-brands-400.woff2'
];

self.addEventListener('install', event => {
	event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(STATIC_ASSETS)));
	self.skipWaiting();
});

self.addEventListener('activate', event => {
	event.waitUntil(Promise.all([
		caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key)))),
		self.clients.claim()
	]));
});

self.addEventListener('fetch', event => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	const scopePath = new URL(self.registration.scope).pathname.replace(/\/$/, '');
	const relativePath = url.pathname.slice(scopePath.length) || '/';
	if (relativePath.startsWith('/api/') || relativePath.startsWith('/p/') || url.searchParams.has('sign')) return;

	if (event.request.mode === 'navigate') {
		event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')));
		return;
	}

	const isStaticAsset = STATIC_ASSETS.some(asset => {
		const assetUrl = new URL(asset, self.registration.scope);
		return assetUrl.pathname === url.pathname && assetUrl.search === url.search;
	});
	if (!isStaticAsset) return;

	event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
