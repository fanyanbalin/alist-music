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
// 网易云音乐 API Enhanced 部署地址（唯一配置点，更换部署地址只需修改此处，不影响其他参数）
window.NCM_API_BASE = 'https://ncm-api.prod.gbclstudio.cn/';
window.albumSbgImg =
	`data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" class="icon" viewBox="0 0 2056 2056"><path fill="rgba(255,255,255,0.1)" d="M1420.001 512H1484v735.996c0 88.369-100.289 160.007-224.006 160.007s-224.006-71.638-224.006-160.007c0-88.37 100.289-160.008 224.006-160.008 62.688 0 119.335 18.391 160.007 48.046v-368.04L908.011 881.78v494.214c0 88.37-100.288 160.007-224.005 160.007S460 1464.362 460 1375.993s100.289-160.007 224.006-160.007c62.688 0 119.334 18.39 160.007 48.045V639.997z"/></svg>')}`;
window.searchOptions = [{
	k: "网易云音乐",
	v: "netease"
}]
window.cacheKey = {
	searchHistory: 'searchHistory',
	lyricHistory: 'lyricHistory',
	playMode: 'dm_playMode',
	fontSize: 'dm_fontSize',
	currInd: 'dm_currInd',
	currTime: 'dm_currTime',
}
window.songAssetCache = window.songAssetCache || {
	lyric: {},
	lyricReq: {},
	cover: {},
	coverReq: {},
	url: {},
	audioLoad: {}
}
window.getApiBasesBySource = function(source) {
	return [NCM_API_BASE];
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
		const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout));
		return await Promise.race([fetchPromise, timeoutPromise]);
	} catch (e) {
		console.debug(`requestNcmApi ${path} failed:`, params, e);
		// 返回错误标记对象，让调用方区分"网络错误"与"业务空结果"
		return {
			__error: true,
			message: e && e.message ? e.message : String(e)
		};
	}
}
// 兼容旧调用：只保留网易云单一来源，直接转发到 Enhanced 接口
window.requestMusicApi = async function(type, source, params = {}, options = {}) {
	const pathMap = {
		search: 'search',
		url: 'song/url',
		lyric: 'lyric',
		pic: 'song/detail',
		playlist: 'playlist/detail'
	};
	const path = pathMap[type];
	if (!path) return null;
	const q = { ...params };
	if (type === 'search') {
		q.keywords = params.name;
		delete q.name;
		q.limit = params.count || 30;
		delete q.count;
		q.type = params.type || 1;
	}
	if (type === 'url') {
		// br 参数为 kbps，Enhanced 接口 br 单位为 bps
		if (q.br && !/000$/.test(String(q.br))) q.br = q.br * 1000;
	}
	return requestNcmApi(path, q, options);
}
/****************************************** 音乐相关接口, 单独提出, 方便扩展其他源 *******************************************/
// 音质档位 → Enhanced 接口 level 映射
const NCM_LEVEL_MAP = {
	'128': 'standard',
	'192': 'higher',
	'320': 'exhigh',
	'740': 'lossless',
	'999': 'hires'
};
// 获取单曲播放链接（Enhanced: /song/url/v1），未登录/非会员返回试听片段
window.getNetEaseSongUrl = async function(id, level) {
	const data = await requestNcmApi('song/url/v1', {
		id,
		level,
		unblock: 'true'
	}, {
		timeout: 8000,
		isValid: one => !!((one && one.data && one.data[0] && (one.data[0].url || one.data[0].proxyUrl)))
	});
	const one = data && data.data && data.data[0];
	let url = (one && (one.url || one.proxyUrl)) || '';
	if (!url) return null;
	if (location.protocol === 'https:' && /^http:/.test(url)) {
		url = url.replace(/^http:/, 'https:')
	}
	return url;
}
window.getSongUrl = async function(song, br) {
	// 优先使用预加载缓存（切歌时零等待），URL 有时效用后即弃
	const urlKey = `${song.source}_${song.id}`;
	if (songAssetCache.url && songAssetCache.url[urlKey]) {
		const cachedUrl = songAssetCache.url[urlKey];
		delete songAssetCache.url[urlKey];
		return cachedUrl;
	}
	try {
		// 按所选音质 → exhigh → higher → standard 降级尝试
		const levels = [...new Set([NCM_LEVEL_MAP[br], 'exhigh', 'higher', 'standard'].filter(Boolean))];
		const url = await getNetEaseSongUrl(song.id, levels[0]);
		if (url) return url;
		// 首选音质失败：并行降级尝试，避免串行等待叠加
		const rest = await Promise.all(levels.slice(1).map(level =>
			getNetEaseSongUrl(song.id, level).catch(() => null)
		));
		return rest.find(u => u) || null
	} catch (e) {
		console.debug('获取歌曲链接失败:', e);
		return null;
	}
}
// 预加载歌曲播放 URL 到内存缓存（用于相邻歌曲预取，切歌零等待）
window.preloadSongUrl = async function(song, br) {
	if (!song || !song.id || song.source === 'alist') return;
	const urlKey = `${song.source}_${song.id}`;
	if (!songAssetCache.url || songAssetCache.url[urlKey]) return;
	try {
		const url = await getSongUrl(song, br);
		if (url) songAssetCache.url[urlKey] = url;
	} catch (e) {}
}
// 预下载歌曲音频数据（隐藏 audio 提前缓冲，切歌时命中 HTTP 缓存立即播放）
window.preloadSongAudio = async function(song, br) {
	if (!song || !song.id || song.source === 'alist') return;
	const urlKey = `${song.source}_${song.id}`;
	if (!songAssetCache.audioLoad || songAssetCache.audioLoad[urlKey]) return;
	songAssetCache.audioLoad[urlKey] = true;
	let audio = null;
	const cleanup = () => {
		if (audio) {
			audio.removeAttribute('src');
			audio.load();
			audio = null;
		}
		delete songAssetCache.audioLoad[urlKey];
	};
	try {
		// 优先读 URL 预加载缓存（不消费，切歌时仍可命中），否则直接请求
		let url = (songAssetCache.url && songAssetCache.url[urlKey]) || null;
		if (!url) {
			const levels = [...new Set([NCM_LEVEL_MAP[br], 'exhigh', 'higher', 'standard'].filter(Boolean))];
			url = await getNetEaseSongUrl(song.id, levels[0]);
			if (!url) {
				for (const level of levels.slice(1)) {
					url = await getNetEaseSongUrl(song.id, level);
					if (url) break;
				}
			}
		}
		if (!url) return cleanup();
		audio = new Audio();
		audio.preload = 'auto';
		audio.muted = true;
		audio.crossOrigin = 'anonymous';
		audio.style.display = 'none';
		audio.style.position = 'absolute';
		// 挂载到 DOM 确保触发下载（CDN 响应缓存 1 年，主播放器切歌时命中缓存立即播放）
		document.body.appendChild(audio);
		audio.addEventListener('canplaythrough', cleanup, { once: true });
		audio.addEventListener('error', cleanup, { once: true });
		audio.addEventListener('stalled', cleanup, { once: true });
		audio.src = url;
		setTimeout(cleanup, 60000);
	} catch (e) {
		cleanup();
	}
}
// 获取网易云歌词（Enhanced: /lyric），返回 lrc.lyric 文本
window.getNetEaseLyric = async function(id, timeout = 10000) {
	try {
		const data = await requestNcmApi('lyric', {
			id
		}, {
			timeout,
			isValid: d => !!(d && d.lrc && d.lrc.lyric)
		});
		const lyric = (data && data.lrc && data.lrc.lyric) || '';
		return lyric || null;
	} catch (e) {
		console.debug('获取歌词失败:', e);
		return null;
	}
};
window.getSongLyric = async function(song, specificSource) {
	const key = `${song.source}_${song.id}${specificSource ? '_' + specificSource : ''}`;
	if (songAssetCache.lyric[key]) return songAssetCache.lyric[key];
	if (!songAssetCache.lyricReq[key]) {
		const req = getNetEaseLyric(song.lyric_id || song.id).then(lyric => {
			if (lyric) songAssetCache.lyric[key] = lyric;
			delete songAssetCache.lyricReq[key];
			return lyric;
		}).catch(e => {
			delete songAssetCache.lyricReq[key];
			console.debug(e);
			return null;
		});
		songAssetCache.lyricReq[key] = req;
	}
	return songAssetCache.lyricReq[key];
}
// 获取歌曲详情（Enhanced: /song/detail），用于补全封面 al.picUrl
window.getNetEaseSongDetail = async function(ids) {
	const idStr = Array.isArray(ids) ? ids.join(',') : ids;
	const data = await requestNcmApi('song/detail', {
		ids: idStr
	}, {
		timeout: 15000,
		isValid: d => !!(d && Array.isArray(d.songs) && d.songs.length)
	});
	return (data && data.songs) || [];
}
window.getAlbumCoverUrl = async function(song, size = 300) {
	if (!song || !song.id) return albumSbgImg;
	const key = `${song.source}_${song.id}`;
	if (songAssetCache.cover[key]) return songAssetCache.cover[key];
	if (songAssetCache.coverReq[key]) return songAssetCache.coverReq[key];
	// 1) 直链优先：歌单/详情返回的 al.picUrl 已是完整 CDN 链接
	let direct = song.pic || (song.al && song.al.picUrl) || '';
	if (direct) {
		songAssetCache.coverReq[key] = new Promise(resolve => {
			let url = direct;
			if (location.protocol === 'https:' && /^http:/.test(url)) {
				url = url.replace(/^http:/, 'https:');
			}
			if (!/[?&]param=/.test(url)) {
				url += `${url.includes('?') ? '&' : '?'}param=${size}y${size}`;
			}
			const img = new Image();
			img.onload = () => {
				songAssetCache.cover[key] = url;
				delete songAssetCache.coverReq[key];
				resolve(url);
			};
			img.onerror = () => {
				delete songAssetCache.coverReq[key];
				songAssetCache.cover[key] = albumSbgImg;
				resolve(albumSbgImg);
			};
			setTimeout(() => {
				if (songAssetCache.coverReq[key]) {
					delete songAssetCache.coverReq[key];
					songAssetCache.cover[key] = albumSbgImg;
					resolve(albumSbgImg);
				}
			}, 8000);
			img.src = url;
		});
		return songAssetCache.coverReq[key];
	}
	// 2) 无直链：通过 /song/detail 获取 al.picUrl
	songAssetCache.coverReq[key] = getNetEaseSongDetail(song.id).then(songs => {
		const s = songs[0];
		let url = (s && s.al && s.al.picUrl) || '';
		if (!url) return albumSbgImg;
		if (location.protocol === 'https:' && /^http:/.test(url)) {
			url = url.replace(/^http:/, 'https:');
		}
		if (!/[?&]param=/.test(url)) {
			url += `${url.includes('?') ? '&' : '?'}param=${size}y${size}`;
		}
		songAssetCache.cover[key] = url;
		delete songAssetCache.coverReq[key];
		return url;
	}).catch(e => {
		delete songAssetCache.coverReq[key];
		console.debug('获取封面失败:', e);
		return albumSbgImg;
	});
	return songAssetCache.coverReq[key];
}
// 网易云歌曲格式 → 项目内部统一格式（兼容 /search 的 artists/album 与 /song/detail、歌单的 ar/al）
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
// 网易云搜索（Enhanced: /search），返回标准化歌曲数组，并批量补全封面
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
	const normalized = songs.map(s => normalizeNeteaseSong(s));
	// 搜索响应只有 picId 没有完整封面 URL，批量 /song/detail 补全
	try {
		const details = await getNetEaseSongDetail(normalized.map(s => s.id));
		const picMap = {};
		details.forEach(s => {
			if (s && s.al && s.al.picUrl) picMap[s.id] = s.al.picUrl;
		});
		normalized.forEach(s => {
			if (picMap[s.id] && !s.pic) s.pic = picMap[s.id];
		});
	} catch (e) {}
	return normalized;
}
window.searchMusicBind = async function(keyword, source) {
	if (!this.searchKeyword.trim()) return this.showNotification('请输入搜索关键词', 'warning');
	const key = `${source}_${keyword}`;
	if (this.searchHistory[key]) {
		this.searchResults = this.searchHistory[key];
		return
	}
	try {
		this.searchResults = await getNetEaseSearch(keyword, 30) || [];
	} catch (e) {
		console.error(e);
		return this.showNotification('网络连接失败，请检查网络后重试', 'error');
	}
	if (!this.searchResults.length) {
		return showNotification('未找到相关歌曲，请尝试其他关键词', 'warning');
	}
	this.searchHistory[key] = this.searchResults;
	setStorage(cacheKey.searchHistory, this.searchHistory);
}
window.refreshBind = async function() {}
window.sourceChangeBind = async function() {
	if (this.searchKeyword && this.searchKeyword.trim()) {
		this.searchMusic();
	}
}
window.uploadLyricBind = async function() {}
window.mixin = {}
