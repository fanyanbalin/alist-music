window.AList = {
	getToken: () => window.alistToken || null,
	getApiToken: () => request.post('/api/auth/login', {
		username: alist[2],
		password: alist[3]
	}, { _skipAListRelogin: true }).then(({ data }) => data.token),
	getFileInfo: path => request.post('/api/fs/get', { path }),
	getRawFile: (path, params) => request.get(`/p${encodePathSegments(path)}`, { params }),
	uploadRawFile: (data, path) => request.put('/api/fs/form', data, {
		headers: { 'File-Path': encodeURIComponent(path) }
	}),
	listDirectory: async (path, isForce) => {
		const url = `/api/fs/list${isForce ? `?t=${Date.now()}` : ''}`;
		const response = await request.post(url, { path });
		return response && response.data && Array.isArray(response.data.content) ? response.data.content : [];
	},
	listAllSong: async (path, isForce) => {
		const result = await AppCore.scanAListTree(path, directory => AList.listDirectory(directory, isForce), {
			concurrency: 6,
			maxDepth: 5
		});
		if (result.errors.length) {
			console.warn(`曲库扫描完成，但有 ${result.errors.length} 个目录读取失败`, result.errors);
			showNotification(`${result.errors.length} 个目录读取失败，已加载其余歌曲`, 'warning', 5);
		}
		return result.files;
	}
};
window.withVueApp = function(callback, retry = 0) {
	if (window.vueApp) return callback(window.vueApp);
	// 最多重试 30s（CDN 加载缓慢时也能等到 Vue 挂载）
	if (retry > 600) return;
	setTimeout(() => window.withVueApp(callback, retry + 1), 50);
};

function getAListScopeKey(name) {
	const scope = window.alist ? `${alist[0]}|${alist[1]}|${alist[2]}` : 'default';
	return `${name}_${md5(scope)}`;
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
(async function initializeAList() {
	if (!isAList) return;
	const params = new URLSearchParams(location.search);
	if (params.has('alist')) {
		params.delete('alist');
		const cleanQuery = params.toString();
		history.replaceState(null, '', `${location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${location.hash}`);
		showNotification('已忽略 URL 中的 AList 凭据，请通过安全表单重新输入', 'warning', 6);
	}
	AppCore.hideBootStatus();
	const stored = await getStorage('alist_config');
	let savedConfig = stored && !Array.isArray(stored) ? stored : null;

	while (true) {
		const config = await AppCore.requestAListConfig(savedConfig);
		savedConfig = {
			baseUrl: config.baseUrl,
			musicPath: config.musicPath,
			username: config.username
		};
		toggleLoading(true);
		try {
			window.alist = [config.baseUrl, config.musicPath, config.username, config.password];
			await setStorage('alist_config', savedConfig);
			window.AListUrl = config.baseUrl;
			const musicListCacheKey = getAListScopeKey('alist_MusicList');
			const singerCacheKey = getAListScopeKey('alist_options');
			window.request = axios.create({ baseURL: AListUrl });
			let reloginPromise = null;
			const shouldRelogin = requestConfig => requestConfig && !requestConfig._skipAListRelogin && !requestConfig._alistRetried && !String(requestConfig.url || '').includes('/api/auth/login');
			request.interceptors.response.use(
				async response => {
					const data = response.data;
					if (data && data.code === 401 && shouldRelogin(response.config)) {
						response.config._alistRetried = true;
						const token = await relogin();
						if (token) {
							response.config.headers = response.config.headers || {};
							response.config.headers.Authorization = token;
							return request(response.config);
						}
					}
					return data;
				},
				async error => {
					const status = error && error.response && error.response.status;
					if (status === 401 && shouldRelogin(error.config)) {
						error.config._alistRetried = true;
						const token = await relogin();
						if (token) {
							error.config.headers = error.config.headers || {};
							error.config.headers.Authorization = token;
							return request(error.config);
						}
					}
					return Promise.reject(error);
				}
			);
			window.relogin = function() {
				if (reloginPromise) return reloginPromise;
				reloginPromise = AList.getApiToken().then(token => {
					if (!token) return null;
					window.alistToken = token;
					request.defaults.headers.Authorization = token;
					return token;
				}).catch(error => {
					console.warn('AList 重新登录失败', error);
					return null;
				}).finally(() => {
					reloginPromise = null;
				});
				return reloginPromise;
			};
			const token = await AList.getApiToken();
			if (!token) throw new Error('登录失败，请检查 AList 地址、用户名和密码');
			window.alistToken = token;
			request.defaults.headers.Authorization = token;

			window.musicList = await getStorage(musicListCacheKey);
			if (!musicList) {
				const songs = await AList.listAllSong(alist[1]);
				if (!songs || !songs.length) throw new Error('没有找到可播放歌曲，请检查音乐路径和目录权限');
				handleSongs(songs);
				musicList = songs.filter(item => item.m);
				await setStorage(musicListCacheKey, musicList);
			}
			withVueApp(app => {
				app.searchResults = musicList;
			});

			window.singers = await getStorage(singerCacheKey);
			if (!singers) {
				try {
					const singerFile = `${alist[1]}/search.json`;
					const { data } = await AList.getFileInfo(singerFile);
					if (data && data.raw_url) {
						const response = await AList.getRawFile(singerFile, {
							sign: data.sign,
							alist_ts: Date.now()
						});
						if (response && response.singers && response.singers.length) {
							window.singers = response.singers;
							await setStorage(singerCacheKey, singers);
						}
					}
				} catch (error) {
					console.warn('获取歌手列表失败:', error);
				}
			}
			if (singers && singers.length) {
				withVueApp(app => {
					app.options = [{ k: '全部歌手', v: '' }].concat(singers.map(value => ({ k: value, v: value })));
					app.selectedSource = '';
				});
			}
			toggleLoading();
			break;
		} catch (error) {
			console.error('AList 初始化失败', error);
			const message = error && error.message ? error.message : 'AList 初始化失败，请检查配置后重试';
			toggleLoading();
			showNotification(message, 'error', 6);
			AppCore.reopenAListConfig(message);
		}
	}
})();
	if (isAList) {
	window.cacheKey = {
		lyricHistory: 'alist_lyricHistory',
		coverHistory: 'alist_coverHistory',
		playMode: 'alist_playMode',
		fontSize: 'dm_fontSize',
		currInd: 'alist_currInd',
		currTime: 'alist_currTime',
		playbackSongKey: 'alist_playbackSongKey',
		playbackState: 'alist_playbackState',
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
			const response = await AList.getFileInfo(`${song.path}/${song.name}`);
			const info = (response && response.data) || {};
			let url = info.raw_url || null;
			// HTTPS 页面不能直接加载 HTTP 直链；有签名时优先走 AList 同源代理。
			if (url && location.protocol === 'https:' && /^http:/.test(url) && info.sign) {
				url = `${AListUrl}/p${encodePathSegments(song.path)}/${encodeURIComponent(song.name)}?sign=${encodeURIComponent(info.sign)}&alist_ts=${Date.now()}`;
			}
			// raw_url 为空时，仍按旧版回退到签名代理地址。
			if (!url && info.sign) {
				url = `${AListUrl}/p${encodePathSegments(song.path)}/${encodeURIComponent(song.name)}?sign=${encodeURIComponent(info.sign)}&alist_ts=${Date.now()}`;
			}
			if (url && location.protocol === 'https:' && /^http:/.test(url)) {
				url = url.replace(/^http:/, 'https:');
			}
			return url;
		} catch (error) {
			console.warn('获取 AList 音乐链接失败:', error);
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
		window.alistToken = null;
		delete request.defaults.headers.Authorization;
		setStorage('alist_config', null)
		setStorage(getAListScopeKey('alist_MusicList'), null)
		setStorage(getAListScopeKey('alist_options'), null)
		location.reload()
	}
}
