(function(global) {
	'use strict';

	const DEFAULT_SCAN_CONCURRENCY = 6;
	const DEFAULT_SCAN_DEPTH = 5;

	function isLocalHost(hostname) {
		return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
	}

	function normalizeAListBaseUrl(value) {
		const url = new URL(String(value || '').trim());
		if (url.username || url.password || url.search || url.hash) {
			throw new Error('AList 地址不能包含账号、密码、查询参数或片段');
		}
		if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
			throw new Error('AList 地址必须使用 HTTPS；仅本机开发允许 HTTP');
		}
		url.pathname = url.pathname.replace(/\/+$/, '');
		return url.toString().replace(/\/$/, '');
	}

	function normalizeMusicPath(value) {
		const path = String(value || '').trim().replace(/\\/g, '/');
		if (!path.startsWith('/')) throw new Error('音乐路径必须是以 / 开头的绝对路径');
		const segments = path.split('/');
		if (segments.some(segment => segment === '..' || segment === '.')) {
			throw new Error('音乐路径不能包含 . 或 ..');
		}
		return path.length > 1 ? path.replace(/\/+$/, '') : path;
	}

	function validateAListConfig(input) {
		const source = Array.isArray(input) ? {
			baseUrl: input[0],
			musicPath: input[1],
			username: input[2],
			password: input[3]
		} : (input || {});
		const username = String(source.username || '').trim();
		const password = String(source.password || '');
		if (!username) throw new Error('请输入 AList 用户名');
		if (!password) throw new Error('请输入 AList 密码');
		return {
			baseUrl: normalizeAListBaseUrl(source.baseUrl),
			musicPath: normalizeMusicPath(source.musicPath),
			username,
			password
		};
	}


	function sanitizeRemoteUrl(value) {
		const url = new URL(String(value || '').trim());
		if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
			throw new Error('资源链接必须使用 HTTPS；仅本机资源允许 HTTP');
		}
		return url.toString();
	}

	function sanitizeDownloadUrl(value) {
		const url = new URL(String(value || '').trim());
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			return url.toString();
		}
		throw new Error('下载链接必须使用 HTTP 或 HTTPS');
	}

	async function mapWithConcurrency(items, limit, mapper) {
		const results = new Array(items.length);
		let nextIndex = 0;
		const workerCount = Math.min(Math.max(1, limit), items.length);
		const workers = Array.from({ length: workerCount }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex++;
				results[index] = await mapper(items[index], index);
			}
		});
		await Promise.all(workers);
		return results;
	}

	async function scanAListTree(rootPath, listDirectory, options = {}) {
		const maxDepth = options.maxDepth || DEFAULT_SCAN_DEPTH;
		const concurrency = options.concurrency || DEFAULT_SCAN_CONCURRENCY;
		let currentLevel = [normalizeMusicPath(rootPath)];
		const files = [];
		const errors = [];

		for (let depth = 1; depth <= maxDepth && currentLevel.length; depth++) {
			const levelResults = await mapWithConcurrency(currentLevel, concurrency, async path => {
				try {
					const content = await listDirectory(path);
					return { path, content: Array.isArray(content) ? content : [] };
				} catch (error) {
					return { path, error };
				}
			});
			const nextLevel = [];
			for (const result of levelResults) {
				if (result.error) {
					errors.push({ path: result.path, error: result.error });
					continue;
				}
				for (const entry of result.content) {
					const entryPath = `${result.path}/${entry.name}`.replace(/\/{2,}/g, '/');
					if (entry.is_dir) {
						if (depth < maxDepth) nextLevel.push(entryPath);
					} else {
						files.push({
							name: entry.name,
							path: result.path,
							is_dir: false,
							size: entry.size
						});
					}
				}
			}
			currentLevel = nextLevel;
		}

		if (errors.length && !files.length) {
			const error = new Error(`曲库扫描失败：${errors[0].path}`);
			error.cause = errors[0].error;
			error.scanErrors = errors;
			throw error;
		}
		return { files, errors };
	}

	function shuffleIndexes(length, random = Math.random) {
		const indexes = Array.from({ length }, (_, index) => index);
		for (let index = indexes.length - 1; index > 0; index--) {
			const swapIndex = Math.floor(random() * (index + 1));
			[indexes[index], indexes[swapIndex]] = [indexes[swapIndex], indexes[index]];
		}
		return indexes;
	}

	function parseLrc(text) {
		if (!text) return [];
		const result = [];
		for (const line of String(text).split(/\r?\n/)) {
			const tags = [...line.matchAll(/\[(\d+):(\d{2})(?:[.,](\d{1,3}))?\]/g)];
			if (!tags.length) continue;
			const lyric = line.slice(tags[tags.length - 1].index + tags[tags.length - 1][0].length).trim();
			if (!lyric) continue;
			for (const tag of tags) {
				const fraction = tag[3] ? Number(tag[3].padEnd(3, '0')) / 1000 : 0;
				result.push({
					time: Number(tag[1]) * 60 + Number(tag[2]) + fraction,
					text: lyric
				});
			}
		}
		return result.sort((a, b) => a.time - b.time);
	}

	function getFileExtension(name) {
		const match = String(name || '').match(/\.([a-z0-9]+)$/i);
		return match ? `.${match[1].toLowerCase()}` : '';
	}

	function showBootError(message) {
		const status = document.getElementById('boot-status');
		if (!status) return;
		status.hidden = false;
		status.querySelector('[data-boot-message]').textContent = message;
	}

	function hideBootStatus() {
		const status = document.getElementById('boot-status');
		if (status) status.hidden = true;
	}

	function reopenAListConfig(message = '') {
		const dialog = document.getElementById('alist-config-dialog');
		const errorNode = document.getElementById('alist-config-error');
		if (!dialog || typeof dialog.showModal !== 'function') return;
		if (errorNode) errorNode.textContent = message;
		if (!dialog.open) dialog.showModal();
		const password = document.querySelector('#alist-config-form [name="password"]');
		if (password) setTimeout(() => password.focus(), 0);
	}

	function requestAListConfig(savedConfig) {
		return new Promise(resolve => {
			const dialog = document.getElementById('alist-config-dialog');
			const form = document.getElementById('alist-config-form');
			const errorNode = document.getElementById('alist-config-error');
			const fields = {
				baseUrl: form.elements.baseUrl,
				musicPath: form.elements.musicPath,
				username: form.elements.username,
				password: form.elements.password
			};
			fields.baseUrl.value = savedConfig && savedConfig.baseUrl || '';
			fields.musicPath.value = savedConfig && savedConfig.musicPath || '/music';
			fields.username.value = savedConfig && savedConfig.username || '';
			fields.password.value = '';
			errorNode.textContent = '';
			const submit = event => {
				event.preventDefault();
				try {
					const config = validateAListConfig(Object.fromEntries(new FormData(form)));
					form.removeEventListener('submit', submit);
					dialog.close();
					resolve(config);
				} catch (error) {
					errorNode.textContent = error.message;
				}
			};
			form.addEventListener('submit', submit);
			dialog.showModal();
			setTimeout(() => (savedConfig && savedConfig.baseUrl ? fields.password : fields.baseUrl).focus(), 0);
		});
	}

	const api = {
		getFileExtension,
		hideBootStatus,
		mapWithConcurrency,
		normalizeAListBaseUrl,
		normalizeMusicPath,
		parseLrc,
		requestAListConfig,
		reopenAListConfig,
		sanitizeDownloadUrl,
		sanitizeRemoteUrl,
		scanAListTree,
		showBootError,
		shuffleIndexes,
		validateAListConfig
	};

	global.AppCore = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;

	if (typeof document !== 'undefined') {
		const required = ['Vue', 'pako', 'localforage', 'axios', 'md5'];
		global.__aListMusicDepsReady = required.every(name => Boolean(global[name]));
		document.addEventListener('DOMContentLoaded', () => {
			const reload = document.getElementById('boot-reload');
			if (reload) reload.addEventListener('click', () => location.reload());
			const missing = required.filter(name => !global[name]);
			if (missing.length) showBootError(`核心资源加载失败：${missing.join(', ')}`);
		});
	}
})(typeof window !== 'undefined' ? window : globalThis);
