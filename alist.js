// 简单并发池：限制同一时刻运行的任务数，避免并发请求过多压垮服务器
function createListPool(limit) {
	let active = 0
	const queue = []
	const pump = () => {
		while (active < limit && queue.length) {
			const { task, resolve } = queue.shift()
			active++
			task().then(resolve, resolve).finally(() => {
				active--
				pump()
			})
		}
	}
	return {
		run(task) {
			return new Promise(resolve => {
				queue.push({ task, resolve })
				pump()
			})
		}
	}
}

window.AList = {
	getToken: () => getStorageExp(getAListScopeKey('alist_token')),
	getApiToken: () => request.post(`/api/auth/login`, {
		username: alist[2],
		password: alist[3]
	}).then(({
		data
	}) => data.token).catch(() => null),
	getFileInfo: (path) => request.post(`/api/fs/get`, {
		path
	}),
	// 对路径逐段编码，兼容目录/文件名含空格、&、#、? 的情况
	getRawFile: (path, params) => request.get(`/p${encodePathSegments(path)}`, {
		params
	}),
	uploadRawFile: (data, path) => request.put(`/api/fs/form`, data, {
		headers: {
			'File-Path': encodeURIComponent(path)
		}
	}), // 'Content-Type': 'multipart/form-data', 
	listAllSong: async (path, isForce) => {
		let result = []
		try {
			result = await AList.listSong(path, 1, isForce) // 从根目录开始
		} catch (e) {}
		return result
	},
	// 获取文件目录的递归函数（并发拉取子目录，显著加快大曲库首次加载）
	listSong: async (path = '', depth = 1, isForce, pool) => {
		if (depth > 5) return [] // 最大递归深度为 5
		try {
			const url = `/api/fs/list${isForce ? ('?t=' + new Date().getTime()) : ''}`
			const res = await request({
				url,
				method: 'post',
				data: {
					path
				}
			})
			const files = res.data.content || []
			const result = []
			const dirs = []
			for (const file of files) {
				const filePath = `${path}/${file.name}`
				if (file.is_dir) {
					dirs.push(filePath)
				} else {
					result.push({
						name: file.name,
						path: path,
						is_dir: file.is_dir,
						size: file.size
					})
				}
			}
			// 同一并发池限制同时请求数，避免压垮服务器
			if (!pool) pool = createListPool(6)
			const nested = await Promise.all(dirs.map(d =>
				pool.run(() => AList.listSong(d, depth + 1, isForce, pool))
			))
			nested.forEach(arr => result.push(...arr))
			return result
		} catch (e) {}
		return []
	}
}
window.withVueApp = function(callback, retry = 0) {
	if (window.vueApp) return callback(window.vueApp);
	// 最多重试 30s（CDN 加载缓慢时也能等到 Vue 挂载）
	if (retry > 600) return;
	setTimeout(() => window.withVueApp(callback, retry + 1), 50);
};

function getAListScopeKey(name) {
	const scope = window.alist ? `${alist[0]}|${alist[1]}` : 'default';
	return `${name}_${md5(scope).slice(0, 8)}`;
}

function isMusic(val) {
	return /\.(mp3|wav|aac|flac)$/i.test(val)
} // |wma 浏览器不支持
function getFileName(val) {
	return val.lastIndexOf('.') === -1 ? val : val.slice(0, val.lastIndexOf('.'))
}
// 路径逐段 URL 编码（保留 / 分隔符），兼容文件名含空格/&/?# 的情况
function encodePathSegments(path) {
	return String(path || '').split('/').map(seg => encodeURIComponent(seg)).join('/')
}

function handleSongs(songs) {
	const lrcMap = {};
	songs.forEach(item => {
		if (item.name.toLowerCase().endsWith('.lrc')) {
			const key = `${item.path}/${getFileName(item.name)}`.toLowerCase();
			lrcMap[key] = item;
		}
	})
	songs.forEach(item => {
		if (!isMusic(item.name)) return;
		item.id = md5(item.path + item.name).slice(0, 8)
		item.m = true
		item.artist = item.path;
		item.source = 'alist'
		const key = `${item.path}/${getFileName(item.name)}`.toLowerCase();
		const one = lrcMap[key];
		if (one) {
			item.lyric = `${one.path}/${one.name}`;
			item.album = '[本地歌词]';
		}
	})
}

// AList 专属模式（已移除云音乐/网易云播放模式）
window.isAList = true;
(async function() {
	if (!isAList) return; // ?t=a  开启AList
	toggleLoading(true);
	try {
	// 支持 URL 参数配置：?alist=域名|路径|用户名|密码（便于部署与调试，配置会持久化）
	const urlAlist = new URLSearchParams(location.search).get('alist');
	window.alist = await getStorage('alist_config')
	if (!alist && urlAlist) {
		alist = urlAlist.split('|')
		if (alist.length == 4) setStorage('alist_config', alist)
	}
	if (!alist) {
		alist = (prompt('请输入alist: alist域名|音乐绝对路径|username|password',
			'https://alist.xyf111.top|/music|admin|admin') || '').split('|')
		if (alist.length != 4) return;
		setStorage('alist_config', alist)
	}
	window.AListUrl = alist[0]
	const tokenCacheKey = getAListScopeKey('alist_token')
	const musicListCacheKey = getAListScopeKey('alist_MusicList')
	const singerCacheKey = getAListScopeKey('alist_options')
	window.request = axios.create({
		baseURL: AListUrl
	})
	// AList 接口统一剥壳 + 401/403 自动重登重试一次（HTTP 层与 body.code 层都覆盖）
	request.interceptors.response.use(
		async (response) => {
			const data = response.data;
			if (data && (data.code === 401 || data.code === 403) && !response.config._alistRetried) {
				response.config._alistRetried = true;
				const token = await relogin();
				if (token) {
					response.config.headers = response.config.headers || {};
					response.config.headers['Authorization'] = token;
					return request(response.config);
				}
			}
			return data;
		},
		async (error) => {
			const status = error && error.response && error.response.status;
			if ((status === 401 || status === 403) && error.config && !error.config._alistRetried) {
				error.config._alistRetried = true;
				const token = await relogin();
				if (token) {
					error.config.headers = error.config.headers || {};
					error.config.headers['Authorization'] = token;
					return request(error.config);
				}
			}
			return Promise.reject(error);
		}
	)
	// 重新登录并更新 token（供拦截器与启动流程复用）
	window.relogin = async function() {
		const tokenKey = getAListScopeKey('alist_token');
		setStorageExp(tokenKey, null);
		const token = await AList.getApiToken();
		if (!token) return null;
		setStorageExp(tokenKey, token, 24 * 60 * 60);
		request.defaults.headers['Authorization'] = token;
		return token;
	}
	if (!AList.getToken()) {
		let token = await AList.getApiToken()
		if (!token) return showNotification('登录失败，无法获取AList Token，请检查地址与账号密码', 'error');
		setStorageExp(tokenCacheKey, token, 24 * 60 * 60)
	}
	request.defaults.headers['Authorization'] = AList.getToken()
	// 请求播放列表
	window.musicList = await getStorage(musicListCacheKey)
	if (!musicList) {
		let songs = await AList.listAllSong(alist[1])
		if (!songs || !songs.length) return showNotification('获取音乐列表失败，请检查音乐路径', 'error');
		handleSongs(songs);
		musicList = songs.filter(item => item.m)
		setStorage(musicListCacheKey, musicList)
	}
	withVueApp(app => {
		app.searchResults = musicList
	})
	// 获取搜索项
	window.singers = await getStorage(singerCacheKey)
	if (!singers) {
		try {
			const singerFile = `${alist[1]}/search.json`
			const {
				data
			} = await AList.getFileInfo(singerFile)
			if (data && data.raw_url) {
				const res = await AList.getRawFile(singerFile, {
					sign: data.sign,
					alist_ts: Date.now()
				})
				if (res && res.singers && res.singers.length) {
					window.singers = res.singers
					setStorage(singerCacheKey, singers)
				}
			}
		} catch (e) {
			console.warn('获取歌手列表失败:', e);
		}
	}
	if (singers && singers.length) {
		withVueApp(app => {
			app.options = [{
				k: '全部歌手',
				v: ''
			}].concat(singers.map(x => ({
				k: x,
				v: x
			})))
app.selectedSource = ''
			})
		}
		} finally {
			toggleLoading();
		}
	})()
	if (isAList) {
	window.cacheKey = {
		lyricHistory: 'alist_lyricHistory',
		coverHistory: 'alist_coverHistory',
		playMode: 'alist_playMode',
		fontSize: 'dm_fontSize',
		currInd: 'alist_currInd',
		currTime: 'alist_currTime',
	}
	window.songAssetCache = window.songAssetCache || {
		lyric: {},
		lyricReq: {},
		cover: {},
		coverReq: {},
		coverStoreLoaded: false,
		coverStore: {}
	}
	window.getSongUrl = async function(song, br) {
		try {
			// 401/403 已由 axios 拦截器统一重登并重试
			const res = await AList.getFileInfo(`${song.path}/${song.name}`);
			const info = (res && res.data) || {};
			let url = info.raw_url || null;
			// AList 未配置直链(raw_url 为空)时，使用签名下载链接 /p{path}?sign=
			if (!url && info && info.sign) {
				url = `${AListUrl}/p${encodePathSegments(song.path)}/${encodeURIComponent(song.name)}?sign=${encodeURIComponent(info.sign)}&alist_ts=${Date.now()}`;
			}
			if (url && location.protocol === 'https:' && /^http:/.test(url)) {
				url = url.replace(/^http:/, 'https:');
			}
			return url;
		} catch (e) {
			console.debug(e);
			return null;
		}
	}
	// 仅获取 AList 本地 LRC 歌词；网易云在线歌词由 loadLyrics 直接调用 getNetEaseSearch/getNetEaseLyric
	window.getSongLyric = async function(song, specificSource) {
		if (!song || song.source !== 'alist' || !song.lyric) return null;
		const key = `${song.source}_${song.id}_local`;
		if (songAssetCache.lyric[key]) return songAssetCache.lyric[key];
		if (songAssetCache.lyricReq[key]) return songAssetCache.lyricReq[key];
		songAssetCache.lyricReq[key] = (async function() {
		try {
			const { data } = await AList.getFileInfo(song.lyric);
			// 依赖签名而非 raw_url：raw_url 可能是空（未配置直链），签名下载始终可用
			if (!data || !data.sign) return null;
			const lyric = await AList.getRawFile(song.lyric, {
				sign: data.sign,
				alist_ts: Date.now()
			}).then(res => res && res.message ? null : res);
			if (lyric) songAssetCache.lyric[key] = lyric;
			return lyric;
		} catch (e) {
			console.debug(e);
			return null;
		} finally {
			delete songAssetCache.lyricReq[key];
		}
		})();
		return songAssetCache.lyricReq[key];
	}
	// 共享上传核心：song 需包含 {path, name, id}，lyricContent 为歌词文本
	// 返回 {success, path} 供调用方自行处理提示
	window._autoLrcUploaded = window._autoLrcUploaded || new Set();
	window.doUploadLyricCore = async function(song, lyricContent) {
		if (!song || !song.path || !song.name || !lyricContent) return { success: false };
		const idKey = song.id || md5(song.path + song.name).slice(0, 8);
		const lrcPath = `${song.path}/${getFileName(song.name)}.lrc`;
		// 去重：已自动上传过的跳过
		if (_autoLrcUploaded.has(idKey)) return { success: true, path: lrcPath };
		try {
			const formData = new FormData();
			formData.append('file', new Blob([lyricContent], { type: 'text/plain' }));
			await AList.uploadRawFile(formData, lrcPath);
			_autoLrcUploaded.add(idKey);
			// 更新内存曲库缓存中的歌词路径
			if (typeof musicList !== 'undefined' && musicList) {
				let item = musicList.find(x => x.id == idKey);
				if (item) { item.lyric = lrcPath; setStorage(getAListScopeKey('alist_MusicList'), musicList); }
			}
			return { success: true, path: lrcPath };
		} catch (e) {
			console.warn('自动上传歌词失败:', e);
			return { success: false };
		}
	};
	// 反上传歌词到AList
	window.uploadLyricBind = async function() {
		if (!this.currentSong || !this.currentSong.raw) {
			return showNotification('当前无歌曲信息', 'error')
		}
		const key = `${this.currentSong.raw.source}_${this.currentSong.raw.id}`
		if (this.lyricHistory[key]) {
			const result = await doUploadLyricCore(this.currentSong.raw, this.lyricHistory[key]);
			if (result.success) {
				showNotification('歌词上传成功', 'success');
			} else {
				showNotification('歌词上传失败', 'error');
			}
		} else {
			showNotification('无可上传的歌词', 'warning')
		}
	}
	window.getAlbumCoverUrl = async function(song, size = 300) {
		const key = `${song.source}_${song.id}`;
		if (songAssetCache.cover[key]) return songAssetCache.cover[key];
		if (!songAssetCache.coverStoreLoaded) {
			songAssetCache.coverStore = await getStorage(cacheKey.coverHistory) || {};
			songAssetCache.coverStoreLoaded = true;
		}
		if (songAssetCache.coverStore[key]) {
			songAssetCache.cover[key] = songAssetCache.coverStore[key];
			return songAssetCache.cover[key];
		}
		if (songAssetCache.coverReq[key]) return songAssetCache.coverReq[key];
		songAssetCache.coverReq[key] = (async function() {
		try {
			const fileName = getFileName(song.name).trim();
			const keywords = [fileName];
			const splitName = fileName.split(/\s+-\s+/).pop().trim();
			if (splitName && splitName !== fileName) keywords.push(splitName);

			for (const keyword of keywords) {
				try {
					const results = await window.getNetEaseSearch(keyword, 5) || [];
					for (const item of results) {
						if (!item.id) continue;
						// Meting 图片接口：直接返回图片二进制，仅替换歌曲ID即可
						const url = `${window.METING_API_BASE}?server=netease&type=pic&id=${encodeURIComponent(item.id)}`;
						songAssetCache.cover[key] = url;
						songAssetCache.coverStore[key] = url;
						setStorage(cacheKey.coverHistory, songAssetCache.coverStore);
						return url;
					}
				} catch (e) {
					console.warn('获取封面失败:', keyword, e);
				}
			}
		} catch (e) {
			console.error('获取封面失败:', e);
		} finally {
			delete songAssetCache.coverReq[key];
		}
		songAssetCache.cover[key] = albumSbgImg;
		return albumSbgImg
		})();
		return songAssetCache.coverReq[key];
	}
	window.searchMusicBind = async function(keyword, source) {
		// 空关键词：显示全部曲库（用于"全部歌手"筛选）
		if (!keyword || !keyword.trim()) {
			if (Array.isArray(musicList)) {
				this.searchResults = musicList;
			} else {
				return showNotification('曲库加载中，请稍候再试', 'info');
			}
			return;
		}
		if (!Array.isArray(musicList)) return showNotification('曲库加载中，请稍候再试', 'info');
		this.searchResults = musicList.filter(item => item.name.toLowerCase().includes(keyword.toLowerCase()) ||
			item.path.toLowerCase().includes(keyword.toLowerCase()))
		if (!this.searchResults.length) {
			return showNotification('未找到相关歌曲，请尝试其他关键词', 'warning');
		}
	}
	window.refreshBind = async function() {
		if (!confirm('确定重新刷新列表吗')) return;
		toggleLoading(true);
		try {
			let songs = await AList.listAllSong(alist[1])
			if (!songs || !songs.length) return showNotification('获取音乐列表失败', 'error');
			handleSongs(songs);
			musicList = songs.filter(item => item.m)
			setStorage(getAListScopeKey('alist_MusicList'), musicList)
			withVueApp(app => {
				app.searchResults = musicList
			})
			showNotification(`列表已刷新，共 ${musicList.length} 首`, 'success');
		} finally {
			toggleLoading();
		}
	}
	window.sourceChangeBind = async function() {
		this.searchKeyword = this.selectedSource
		this.searchMusic()
	}
	window.resetAlist = async function() {
		if (!confirm('确定要重置Alist配置吗？')) return;
		// 同时清理 scoped token 与曲库/歌手缓存，避免旧 token 残留导致静默失败
		setStorage('alist_config', null)
		setStorageExp(getAListScopeKey('alist_token'), null)
		setStorage(getAListScopeKey('alist_MusicList'), null)
		setStorage(getAListScopeKey('alist_options'), null)
		location.reload()
	}
}
