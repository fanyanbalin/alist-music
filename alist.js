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
	getRawFile: (path, params) => request.get(`/p${path}`, {
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
			result = await AList.listSong(path, 1, [], isForce) // 从根目录开始
		} catch (e) {}
		return result
	},
	// 获取文件目录的递归函数
	listSong: async (path = '', depth = 1, result = [], isForce) => {
		if (depth > 5) return result // 最大递归深度为 5
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

			for (const file of files) {
				const filePath = `${path}/${file.name}`
				if (file.is_dir) {
					await AList.listSong(filePath, depth + 1, result, isForce)
				} else {
					// 如果是文件，加入到结果中
					result.push({
						name: file.name,
						path: path,
						is_dir: file.is_dir,
						size: file.size
					})
				}
			}
		} catch (e) {}
		return result
	}
}
window.resetAlist = () => {};

window.withVueApp = function(callback, retry = 0) {
	if (window.vueApp) return callback(window.vueApp);
	if (retry > 120) return;
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

// let urlObj = Object.fromEntries(new URLSearchParams(location.search))
window.isAList = getStorageExp('dm_siteType') == 'alist';
(async function() {
	if (!isAList) return; // ?t=a  开启AList

	window.alist = await getStorage('alist_config')
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
	request.interceptors.response.use(({
		data
	}) => data)
	if (!AList.getToken()) {
		let token = await AList.getApiToken()
		if (!token) return showNotification('登录失败，无法获取AList Token', 'error');
		setStorageExp(tokenCacheKey, token, 24 * 60 * 60)
	}
	request.defaults.headers['Authorization'] = AList.getToken()
	// 请求播放列表
	window.musicList = await getStorage(musicListCacheKey)
	if (!musicList) {
		let songs = await AList.listAllSong(alist[1])
		if (!songs || !songs.length) return showNotification('获取音乐列表失败', 'error');
		handleSongs(songs);
		console.log(songs);
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
	setTimeout(() => {
		withVueApp(app => {
			if (app.isPlaySearch) app.randomIndexes = genRandomIndexes(app.searchResults.length)
		})
	}, 200)
})()
window.lyricSources = ['netease', 'kuwo', 'tencent', 'kugou', 'joox', 'migu', 'spotify', 'deezer']
window.currLyricSource = 0
if (isAList) {
	setTimeout(() => withVueApp(app => {
		app.isAList = true
	}), 500)
	window.cacheKey = {
		searchHistory: 'alist_searchHistory',
		lyricHistory: 'alist_lyricHistory',
		coverHistory: 'alist_coverHistory',
		playList: 'alist_playList',
		playMode: 'alist_playMode',
		fontSize: 'dm_fontSize',
		currInd: 'alist_currInd',
		currTime: 'alist_currTime',
		isPlaySearch: 'alist_isPlaySearch',
		currLeftInd: 'alist_currLeftInd',
		currLeftTime: 'alist_currLeftTime',
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
			const res = await AList.getFileInfo(`${song.path}/${song.name}`);
			return res.data?.raw_url || null;
		} catch (e) {
			console.error(e);
			return null;
		}
	}
	window.getSongLyric = async function(song, specificSource, silent) {
		const key = `${song.source}_${song.id}_${song.lyric ? 'local' : (specificSource || 'auto')}`;
		if (songAssetCache.lyric[key]) return songAssetCache.lyric[key];
		if (songAssetCache.lyricReq[key]) return songAssetCache.lyricReq[key];
		songAssetCache.lyricReq[key] = (async function() {
		try {
			if (!song.lyric) {
				// 尝试请求远端歌词接口
				const sources = specificSource ? [specificSource] : ['netease', 'kuwo', 'tencent', 'kugou'];
				const fetchJson = (url, timeout = 8000) => Promise.race([
					fetch(url).then(res => res.json()),
					new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
				]);
				for (const source of sources) {
					try {
						!silent && showNotification(`正在获取歌词：${source}`, 'info');
						let results = await fetchJson(
							`${API_BASE}?types=search&source=${source}&name=${encodeURIComponent(getFileName(song.name))}&count=5`
						) || [];
						if (!results.length) continue;
						const lyrics = await Promise.all(results.map(async item => {
							const id = item.lyric_id || item.id;
							if (!id) return null;
							try {
								return (await fetchJson(
									`${API_BASE}?types=lyric&source=${source}&id=${encodeURIComponent(id)}`
								) || {}).lyric;
							} catch (e) {
								return null;
							}
						}));
						const lyric = lyrics.find(Boolean);
						if (lyric) {
							songAssetCache.lyric[key] = lyric;
							return lyric;
						}
					} catch (e) {
						console.warn('获取歌词失败:', source, e);
					}
				}
				!silent && showNotification('歌词获取失败，可尝试手动刷新', 'warning');
				return null;
			}
			const {
				data
			} = await AList.getFileInfo(song.lyric);
			if (!data.raw_url) return null;
			const lyric = await AList.getRawFile(song.lyric, {
				sign: data.sign,
				alist_ts: Date.now()
			}).then(res => res.message ? null : res);
			if (lyric) songAssetCache.lyric[key] = lyric;
			return lyric;
		} catch (e) {
			console.error(e);
			return null;
		} finally {
			delete songAssetCache.lyricReq[key];
		}
		})();
		return songAssetCache.lyricReq[key];
	}
	// 反上传歌词到AList
	window.uploadLyricBind = async function() {
		if (!this.currentSong || !this.currentSong.raw) {
			return showNotification('当前无歌曲信息', 'error')
		}
		const key = `${this.currentSong.raw.source}_${this.currentSong.raw.id}`
		console.log(key);
		if (this.lyricHistory[key]) {
			const formData = new FormData();
			formData.append('file', new Blob([this.lyricHistory[key]], {
				type: 'text/plain'
			}));
			const path = `${this.currentSong.raw.path}/${getFileName(this.currentSong.raw.name)}.lrc`
			AList.uploadRawFile(formData, path).then(() => {
				showNotification('歌词上传成功', 'success')
				withVueApp(app => {
					if (app.playList) {
						let one = app.playList.find(x => x.id == this.currentSong.raw.id)
						if (one) {
							one.lyric = path
							setStorage(cacheKey.playList, app.playList)
						}
					}
				})
				if (typeof musicList !== 'undefined' && musicList) {
					let item = musicList.find(x => x.id == this.currentSong.raw.id)
					if (item) item.lyric = path
					setStorage(getAListScopeKey('alist_MusicList'), musicList)
				}
			}).catch(e => {
				console.error('歌词上传失败:', e)
				showNotification('歌词上传失败: ' + (e.message || '未知错误'), 'error')
			});
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
			const fetchJson = (url, timeout = 8000) => Promise.race([
				fetch(url).then(res => res.json()),
				new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
			]);
			const sources = ['netease', 'kuwo', 'tencent', 'kugou'];
			const fileName = getFileName(song.name).trim();
			const keywords = [fileName];
			const splitName = fileName.split(/\s+-\s+/).pop().trim();
			if (splitName && splitName !== fileName) keywords.push(splitName);

			for (const keyword of keywords) {
				for (const source of sources) {
					try {
						const results = await fetchJson(
							`${API_BASE}?types=search&source=${source}&name=${encodeURIComponent(keyword)}&count=5`
						) || [];
						for (const item of results) {
							if (!item.pic_id) continue;
							const data = await fetchJson(
								`${API_BASE}?types=pic&source=${source}&id=${encodeURIComponent(item.pic_id)}&size=${size}`
							);
							let url = (data || {}).url;
							if (!url) continue;
							if (location.protocol === 'https:' && /^http:/.test(url)) {
								url = url.replace(/^http:/, 'https:');
							}
							songAssetCache.cover[key] = url + `?param=${size}y${size}`;
							songAssetCache.coverStore[key] = songAssetCache.cover[key];
							setStorage(cacheKey.coverHistory, songAssetCache.coverStore);
							return songAssetCache.cover[key];
						}
					} catch (e) {
						console.warn('获取封面失败:', source, keyword, e);
					}
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
		this.searchResults = musicList.filter(item => item.name.toLowerCase().includes(keyword.toLowerCase()) ||
			item.path.toLowerCase().includes(keyword.toLowerCase()))
		if (!this.searchResults.length) {
			return showNotification('未找到相关歌曲，请尝试其他关键词', 'warning');
		}
	}
	window.refreshBind = async function() {
		console.log(this);
		if (!confirm('确定重新刷新列表吗')) return;
		let songs = await AList.listAllSong(alist[1])
		if (!songs || !songs.length) return showNotification('获取音乐列表失败', 'error');
		handleSongs(songs);
		console.log(songs);
		musicList = songs.filter(item => item.m)
		setStorage(getAListScopeKey('alist_MusicList'), musicList)
		withVueApp(app => {
			app.searchResults = musicList
			if (app.playList && app.playList.length) {
				app.playList.forEach(item => {
					const one = musicList.find(x => x.id == item.id)
					if (one) item.lyric = one.lyric
				})
				setStorage(cacheKey.playList, app.playList)
			}
		})
	}
	window.sourceChangeBind = async function() {
		console.log('sourceChangeBind', this);
		this.searchKeyword = this.selectedSource
		this.searchMusic()
	}
	window.resetAlist = async function() {
		if (!confirm('确定要重置Alist配置吗？')) return;
		setStorage('alist_config', null)
		location.reload()
	}
}

window.syncCode = getStorageExp('dm_syncCode') || ''

function changeSyncCode() {
	let temp = prompt('请输入同步编码, 4-10个字符', syncCode)
	if (!temp || temp.trim().length < 4) return;
	syncCode = temp
	setStorageExp('dm_syncCode', syncCode)
	showNotification('同步编码已保存', 'success');
}

function uploadList(data) {
	if (!confirm('确定要上传覆盖远端列表吗？')) return;
	if (!syncCode) {
		const code = prompt('请输入同步编码, 超过3个字符', '')
		if (!code || code.trim().length < 4) return showNotification('未配置同步编码', 'error');
		syncCode = code
		setStorageExp('dm_syncCode', syncCode)
	}
	let uploadUrl = `//home.199311.xyz:40003/upload?name=gdmusic${window.isAList ? '_alist' : ''}_${syncCode}.dat`
	let arr = pako.deflate(new TextEncoder().encode(JSON.stringify(data)), {
		level: 9
	})
	const formData = new FormData();
	formData.append('file', new Blob([arr], {
		type: 'application/octet-stream'
	}));
	return fetch(uploadUrl, {
		method: 'POST',
		body: formData
	}).then(res => res.text())
}

async function downloadList() {
	if (!syncCode) {
		const code = prompt('请输入同步编码, 超过3个字符', '')
		if (!code || code.trim().length < 4) return showNotification('未配置同步编码', 'error');
		syncCode = code
		setStorageExp('dm_syncCode', syncCode)
	}
	let downloadUrl =
		`//home.199311.xyz:40003/download?name=gdmusic${window.isAList ? '_alist' : ''}_${syncCode}.dat&t=${Date.now()}`
	try {
		const res = await fetch(downloadUrl, {
			method: 'GET'
		}).then(res => res.arrayBuffer())
		return JSON.parse(pako.inflate(new Uint8Array(res), {
			to: 'string'
		}))
	} catch (e) {
		return null;
	}
}
