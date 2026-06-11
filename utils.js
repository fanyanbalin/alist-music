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
	const item = JSON.parse(itemStr);
	return Date.now() < item.exp || item.exp == 0 ? item.val : localStorage.removeItem(key);
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
window.API_BASE = 'https://music-api.gdstudio.xyz/api.php';
window.API_BASES = {
	default: ['https://music.gdstudio.xyz/api.php', 'https://music-api.gdstudio.xyz/api.php',
		'https://music.gdstudio.org/api.php'
	],
	cn: ['https://music.gdstudio.xyz/api.php', 'https://music-api-cn.gdstudio.xyz/api.php',
		'https://music.gdstudio.org/api.php'
	],
	hk: ['https://music.gdstudio.xyz/api.php', 'https://music-api-hk.gdstudio.xyz/api.php',
		'https://music.gdstudio.org/api.php'
	]
};
window.albumSbgImg =
	`data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" class="icon" viewBox="0 0 2056 2056"><path fill="rgba(255,255,255,0.1)" d="M1420.001 512H1484v735.996c0 88.369-100.289 160.007-224.006 160.007s-224.006-71.638-224.006-160.007c0-88.37 100.289-160.008 224.006-160.008 62.688 0 119.335 18.391 160.007 48.046v-368.04L908.011 881.78v494.214c0 88.37-100.288 160.007-224.005 160.007S460 1464.362 460 1375.993s100.289-160.007 224.006-160.007c62.688 0 119.334 18.39 160.007 48.045V639.997z"/></svg>')}`;
window.searchOptions = [{
		k: "网易云音乐",
		v: "netease"
	}, {
		k: "QQ音乐",
		v: "tencent"
	}, {
		k: "酷我音乐",
		v: "kuwo"
	}, {
		k: "JOOX",
		v: "joox"
	},
	{
		k: "酷狗音乐",
		v: "kugou"
	}, {
		k: "咪咕音乐",
		v: "migu"
	}, {
		k: "Deezer",
		v: "deezer"
	}, {
		k: "Spotify",
		v: "spotify"
	}, {
		k: "Apple Music",
		v: "apple"
	},
	{
		k: "YouTube Music",
		v: "ytmusic"
	}, {
		k: "TIDAL",
		v: "tidal"
	}, {
		k: "Qobuz",
		v: "qobuz"
	}, {
		k: "喜马拉雅",
		v: "ximalaya"
	}
]
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
	coverReq: {}
}
window.getApiBasesBySource = function(source) {
	if (['migu', 'kugou', 'ximalaya'].includes(source)) return API_BASES.cn;
	if (source === 'joox') return API_BASES.hk;
	return API_BASES.default;
}
window.buildMusicApiUrl = function(base, type, source, params = {}) {
	const searchParams = new URLSearchParams({
		types: type,
		source,
		...params
	});
	return `${base}?${searchParams.toString()}`;
}
window.requestMusicApi = async function(type, source, params = {}, options = {}) {
	const {
		timeout = 10000,
		isValid
	} = options;
	const bases = getApiBasesBySource(source);
	let lastData = null;
	let lastError = null;
	for (const base of bases) {
		try {
			const fetchPromise = fetch(buildMusicApiUrl(base, type, source, params)).then(res => {
				if (!res.ok) throw new Error(`HTTP status: ${res.status}`);
				return res.json();
			});
			const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout));
			const data = await Promise.race([fetchPromise, timeoutPromise]);
			lastData = data;
			if (!isValid || isValid(data)) return data;
		} catch (e) {
			lastError = e;
		}
	}
	if (lastError) console.debug(`requestMusicApi ${type} failed:`, source, params, lastError);
	return lastData;
}
/****************************************** 音乐相关接口, 单独提出, 方便扩展其他源 *******************************************/
window.getSongUrl = async function(song, br) {
	try {
		const qualityCandidates = [...new Set([br, '320', '192', '128'].filter(Boolean).map(String))];
		for (const quality of qualityCandidates) {
			const data = await requestMusicApi('url', song.source, {
				id: song.id,
				br: quality
			}, {
				timeout: 15000,
				isValid: one => !!((one || {}).url)
			});
			let url = (data || {}).url;
			if (!url) continue;
			if (location.protocol === 'https:' && /^http:/.test(url)) {
				url = url.replace(/^http:/, 'https:')
			}
			if (url) return url;
		}
		return null
	} catch (e) {
		console.debug('获取歌曲链接失败:', e);
		return null;
	}
}
// Netease备用歌词接口
const NETEASE_BACKUP_API = 'https://musicapi.fanyanbalin.dpdns.org';
window.fetchNeteaseBackupLyric = async function(id, timeout = 8000) {
	try {
		const res = await Promise.race([
			fetch(`${NETEASE_BACKUP_API}/lyric?id=${encodeURIComponent(id)}`),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
		]);
		const data = await res.json();
		let lyricText = null;
		if (typeof data === 'string') {
			lyricText = data;
		} else if (data.lrc && data.lrc.lyric) {
			lyricText = data.lrc.lyric;
		} else if (data.lyric) {
			lyricText = data.lyric;
		} else if (data.data && data.data.lyric) {
			lyricText = data.data.lyric;
		} else if (data.data && data.data.lrc && data.data.lrc.lyric) {
			lyricText = data.data.lrc.lyric;
		}
		return lyricText;
	} catch (e) {
		console.debug('备用歌词接口请求失败:', e);
		return null;
	}
};
window.getSongLyric = async function(song, specificSource) {
	const key = `${song.source}_${song.id}${specificSource ? '_' + specificSource : ''}`;
	if (songAssetCache.lyric[key]) return songAssetCache.lyric[key];
	if (!songAssetCache.lyricReq[key]) {
		const targetSource = specificSource || song.source;
		const req = requestMusicApi('lyric', targetSource, {
			id: song.lyric_id || song.id
		}, {
			timeout: 10000,
			isValid: data => !!((data || {}).lyric)
		}).then(data => {
			let lyric = (data || {}).lyric || null;
			if (lyric) {
				songAssetCache.lyric[key] = lyric;
				delete songAssetCache.lyricReq[key];
				return lyric;
			}
			// Netease主接口返回空歌词时尝试备用接口
			if (targetSource === 'netease') {
				const backupId = song.lyric_id || song.id;
				return fetchNeteaseBackupLyric(backupId).then(backupLyric => {
					if (backupLyric) songAssetCache.lyric[key] = backupLyric;
					delete songAssetCache.lyricReq[key];
					return backupLyric;
				});
			}
			delete songAssetCache.lyricReq[key];
			return null;
		}).catch(e => {
			delete songAssetCache.lyricReq[key];
			console.debug(e);
			// Netease异常时也尝试备用接口
			if (targetSource === 'netease') {
				const backupId = song.lyric_id || song.id;
				return fetchNeteaseBackupLyric(backupId).then(backupLyric => {
					if (backupLyric) songAssetCache.lyric[key] = backupLyric;
					return backupLyric;
				});
			}
			return null;
		});
		songAssetCache.lyricReq[key] = req;
	}
	return songAssetCache.lyricReq[key];
}
window.getAlbumCoverUrl = async function(song, size = 300) {
	const coverId = song.pic_id || song.url_id;
	if (!coverId) return albumSbgImg;
	const key = `${song.source}_${song.id}`;
	if (songAssetCache.cover[key]) return songAssetCache.cover[key];
	if (songAssetCache.coverReq[key]) return songAssetCache.coverReq[key];
	// netease 封面直接用 CDN，绕过不稳定的 pic API
	if (song.source === 'netease') {
		songAssetCache.coverReq[key] = new Promise(resolve => {
			const url = `https://p2.music.126.net/${coverId}.jpg?param=${size}y${size}`;
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
	// 其他来源通过 API 获取
	songAssetCache.coverReq[key] = requestMusicApi('pic', song.source, {
		id: coverId,
		size
	}, {
		timeout: 15000,
		isValid: data => !!((data || {}).url)
	}).then(data => {
		let url = (data || {}).url;
		if (!url) return albumSbgImg;
		if (location.protocol === 'https:' && /^http:/.test(url)) {
			url = url.replace(/^http:/, 'https:')
		}
		if (!/[?&]param=/.test(url)) {
			url += `${url.includes('?') ? '&' : '?'}param=${size}y${size}`;
		}
		songAssetCache.cover[key] = url;
		delete songAssetCache.coverReq[key];
		return songAssetCache.cover[key];
	}).catch(e => {
			delete songAssetCache.coverReq[key];
			console.debug('获取封面失败:', e);
		return albumSbgImg;
	});
	return songAssetCache.coverReq[key];
}
window.searchMusicBind = async function(keyword, source) {
	if (!this.searchKeyword.trim()) return this.showNotification('请输入搜索关键词', 'warning');
	const key = `${source}_${keyword}`;
	if (this.searchHistory[key]) {
		this.searchResults = this.searchHistory[key];
		return
	}
	try {
		this.searchResults = await requestMusicApi('search', source, {
			name: keyword,
			count: 30
		}, {
			timeout: 12000,
			isValid: data => Array.isArray(data) && data.length > 0
		}) || [];
	} catch (e) {
		console.error(e);
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
// 从LRC文本中提取最后一句的时间戳(秒)，用于匹配歌曲时长
window.getLastLyricTimestamp = function(lrcText) {
	if (!lrcText) return -1;
	const lines = lrcText.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = lines[i].match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
		if (match) return parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / (match[3].length === 3 ? 1000 : 100);
	}
	return -1;
};
