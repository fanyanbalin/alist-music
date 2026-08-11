/******************************************* 工具类 *******************************************/
localforage.config({
	driver: localforage.INDEXEDDB,
	name: 'gdmusic-db',
	storeName: 'gdmusic-store'
});
async function getStorage(key) {
	const data = await localforage.getItem(key)
	let text = null
	if (data) {
		try {
			text = pako.inflate(data, {
				to: 'string'
			});
			return JSON.parse(text)
		} catch (error) {
			console.log('parse error', error);
			return text
		}
	}
	return text
}

function setStorage(key, val) {
	if (!val && val !== 0) return localforage.removeItem(key)
	let text = JSON.stringify(val)
	const data = pako.deflate(new TextEncoder().encode(text), {
		level: 9
	});
	localforage.setItem(key, data).then(() => {
		const size = data.length / 1024;
		const size1 = new TextEncoder().encode(text).length / 1024; // 转换为KB
		console.debug(
			`${key} 存储成功: ${data.length} 长度, ${size1.toFixed(2)}kb -> ${size.toFixed(2)}kb,  压缩率: ${(100 * size / size1).toFixed(2)}%`
		);
	}).catch(console.error);
}

function setStorageExp(key, val, ttl) {
	localStorage.setItem(key, JSON.stringify({
		val,
		exp: !ttl ? 0 : (Date.now() + ttl * 1000)
	}));
}

function getStorageExp(key) {
	const itemStr = localStorage.getItem(key);
	if (!itemStr) return null;
	try {
		const item = JSON.parse(itemStr);
		return Date.now() < item.exp || item.exp == 0 ? item.val : localStorage.removeItem(key);
	} catch (e) {
		// 数据损坏：移除坏键，返回 null，避免 Vue 初始化崩溃
		console.warn(`getStorageExp 解析失败，已清除坏键: ${key}`, e);
		localStorage.removeItem(key);
		return null;
	}
}

function downloadText(text, name) {
	const url = URL.createObjectURL(new Blob([text], {
		type: 'text/plain;charset=utf-8'
	}));
	const link = Object.assign(document.createElement('a'), {
		href: url,
		download: name
	});
document.body.appendChild(link).click();
link.remove();
setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showNotification(message, type = 'info', duration = 2) {
	// 确保有通知容器
	let container = document.querySelector('.gd-notify-container');
	if (!container) {
		container = Object.assign(document.createElement('div'), {
			className: 'gd-notify-container',
		});
		container.style.cssText = 'position:fixed;top:160px;right:30px;z-index:1000;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
		document.body.appendChild(container);
	}
	// 限制最多3条，超出移除最旧的
	const existing = container.querySelectorAll('.gd-notification');
	if (existing.length >= 3) {
		existing[0].style.opacity = '0';
		existing[0].style.transform = 'translateX(400px)';
		setTimeout(() => { if (existing[0].parentNode) existing[0].remove(); }, 300);
	}
	const bgcolor = type === 'success' ? 'rgba(76, 175, 80, 0.92)' : type === 'error' ? 'rgba(244, 67, 54, 0.92)' :
		type === 'warning' ? 'rgba(255, 152, 0, 0.92)' : 'rgba(33, 150, 243, 0.92)';
	const icon = type === 'success' ? '\u2714 ' : type === 'error' ? '\u2716 ' : type === 'warning' ? '\u26A0 ' : '\u2139 ';
	const notification = Object.assign(document.createElement('div'), {
		className: 'gd-notification',
		textContent: icon + message,
		style: `background:${bgcolor};color:#fff;padding:12px 18px;border-radius:10px;font-size:14px;` +
			`backdrop-filter:blur(10px);box-shadow:0 6px 20px rgba(0,0,0,0.35);` +
			`transform:translateX(400px);transition:all 0.3s ease;max-width:300px;` +
			`pointer-events:auto;cursor:default;`,
	});
	notification.addEventListener('click', () => dismiss(notification));
	container.appendChild(notification);
	requestAnimationFrame(() => { notification.style.transform = 'translateX(0)'; });
	const timer = setTimeout(() => dismiss(notification), duration * 1000);

	function dismiss(el) {
		clearTimeout(timer);
		el.style.opacity = '0';
		el.style.transform = 'translateX(400px)';
		setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
	}
}

function genRandomIndexes(len) {
	const arr = []
	while (arr.length < len) {
		const randomIndex = Math.floor(Math.random() * len)
		// 确保没有重复的值且不等于当前索引
		if (!arr.includes(randomIndex)) arr.push(randomIndex)
	}
	return arr
}

function toggleLoading(isShow) {
	loadingRef.classList.toggle('hide', !isShow)
}

/****************************************** 音乐相关接口 *******************************************/
// 网易云音乐 API Enhanced 部署地址（歌曲搜索，唯一配置点，更换部署地址只需修改此处，不影响其他参数）
window.NCM_API_BASE = 'https://ncm-api.prod.gbclstudio.cn/';
// 网易云图片/歌词接口（Meting 风格，仅需替换歌曲ID）：?server=netease&type=pic|lrc&id=歌曲ID
window.METING_API_BASE = 'https://meting.xyf111.top/api';
window.albumSbgImg =
	`data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" class="icon" viewBox="0 0 2056 2056"><path fill="rgba(255,255,255,0.1)" d="M1420.001 512H1484v735.996c0 88.369-100.289 160.007-224.006 160.007s-224.006-71.638-224.006-160.007c0-88.37 100.289-160.008 224.006-160.008 62.688 0 119.335 18.391 160.007 48.046v-368.04L908.011 881.78v494.214c0 88.37-100.288 160.007-224.005 160.007S460 1464.362 460 1375.993s100.289-160.007 224.006-160.007c62.688 0 119.334 18.39 160.007 48.045V639.997z"/></svg>')}`;
window.searchOptions = [{
	k: "全部",
	v: ""
}]
window.songAssetCache = window.songAssetCache || {
	lyric: {},
	lyricReq: {},
	cover: {},
	coverReq: {},
	coverStore: {},
	coverStoreLoaded: false
}
window.requestNcmApi = async function(path, params = {}, options = {}) {
	const {
		timeout = 10000,
		isValid
	} = options;
	const searchParams = new URLSearchParams(params);
	const url = `${NCM_API_BASE}${path}${searchParams.toString() ? '?' + searchParams.toString() : ''}`;
	try {
		const fetchPromise = fetch(url).then(async res => {
			const text = await res.text();
			if (!res.ok) {
				try {
					const data = JSON.parse(text);
					if (isValid && isValid(data)) return data;
				} catch (_) {}
				throw new Error(`HTTP status: ${res.status}`);
			}
			return JSON.parse(text);
		});
		let timer;
		const timeoutPromise = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error('timeout')), timeout);
		});
		try {
			return await Promise.race([fetchPromise, timeoutPromise]);
		} finally {
			clearTimeout(timer);
		}
	} catch (e) {
		console.debug(`requestNcmApi ${path} failed:`, params, e);
		// 返回错误标记对象，让调用方区分"网络错误"与"业务空结果"
		return {
			__error: true,
			message: e && e.message ? e.message : String(e)
		};
	}
}
// 获取网易云歌词（Meting API: ?type=lrc&id=歌曲ID），接口直接返回 LRC 文本
window.getNetEaseLyric = async function(id, timeout = 10000) {
	try {
		const url = `${METING_API_BASE}?server=netease&type=lrc&id=${encodeURIComponent(id)}`;
		const fetchPromise = fetch(url).then(res => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		});
		let timer;
		const timeoutPromise = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error('timeout')), timeout);
		});
		let text;
		try {
			text = await Promise.race([fetchPromise, timeoutPromise]);
		} finally {
			clearTimeout(timer);
		}
		// 无歌词或接口异常时返回占位文本（如 [00:00.00]暂无歌词），此处统一视为无歌词
		if (!text || /暂无歌词|Searching|No lyrics|not found/i.test(text) || /^\s*</.test(text)) return null;
		return text;
	} catch (e) {
		console.debug('获取歌词失败:', e);
		return null;
	}
};
// 网易云歌曲格式 → 项目内部统一格式（兼容 /search 的 artists/album 与歌单的 ar/al）
window.normalizeNeteaseSong = function(song, source = 'netease') {
	const ar = song.ar || song.artists || [];
	const al = song.al || song.album || {};
	return {
		id: song.id,
		name: song.name || '',
		artist: ar.map(a => (a && a.name) || '').filter(Boolean),
		album: (al && al.name) || '',
		pic: (al && (al.picUrl || al.pic)) || song.pic || '',
		pic_id: song.pic_id || (al && al.picId) || '',
		url_id: song.id,
		lyric_id: song.id,
		dt: song.dt || 0,
		source
	};
}
// 网易云搜索（Enhanced: /search），返回标准化歌曲数组（用于获取歌曲ID，供图片/歌词接口使用）
window.getNetEaseSearch = async function(keyword, limit = 30) {
	const data = await requestNcmApi('search', {
		keywords: keyword,
		limit,
		type: 1
	}, {
		timeout: 12000,
		isValid: d => !!(d && d.result && Array.isArray(d.result.songs) && d.result.songs.length)
	});
	// 网络/接口错误：抛错让调用方区分"网络失败"与"未找到"
	if (data && data.__error) throw new Error(data.message || '网络请求失败');
	const songs = (data && data.result && data.result.songs) || [];
	if (!songs.length) return [];
	return songs.map(s => normalizeNeteaseSong(s));
}
window.mixin = {}
