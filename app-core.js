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
		const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : DEFAULT_SCAN_DEPTH;
		const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : DEFAULT_SCAN_CONCURRENCY;
		let currentLevel = [{ path: normalizeMusicPath(rootPath), depth: 0 }];
		const files = [];
		const errors = [];
		const truncatedDirectories = [];

		// maxDepth is relative to rootPath: rootPath is depth 0 and is always listed.
		// Directories discovered below maxDepth are reported instead of being silently skipped.
		while (currentLevel.length) {
			const levelResults = await mapWithConcurrency(currentLevel, concurrency, async directory => {
				try {
					const content = await listDirectory(directory.path);
					return { ...directory, content: Array.isArray(content) ? content : [] };
				} catch (error) {
					return { ...directory, error };
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
						if (result.depth < maxDepth) nextLevel.push({ path: entryPath, depth: result.depth + 1 });
						else truncatedDirectories.push(entryPath);
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
		return { files, errors, truncatedDirectories };
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

	let configRequest = null;
	let configSubmit = null;
	let configCancel = null;

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
		if (configRequest) return configRequest;
		configRequest = new Promise(resolve => {
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
			configSubmit = event => {
				event.preventDefault();
				try {
					const config = validateAListConfig(Object.fromEntries(new FormData(form)));
					form.removeEventListener('submit', configSubmit);
					dialog.removeEventListener('cancel', configCancel);
					configSubmit = configCancel = null;
					configRequest = null;
					dialog.close();
					resolve(config);
				} catch (error) {
					errorNode.textContent = error.message;
				}
			};
			configCancel = event => event.preventDefault();
			form.addEventListener('submit', configSubmit);
			dialog.addEventListener('cancel', configCancel);
			if (!dialog.open) dialog.showModal();
			setTimeout(() => (savedConfig && savedConfig.baseUrl ? fields.password : fields.baseUrl).focus(), 0);
		});
		return configRequest;
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
