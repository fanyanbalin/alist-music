window.__aListMusicDepsReady = ['Vue', 'pako', 'localforage', 'axios', 'md5'].every(name => Boolean(window[name]));
window.__maybeStartAListMusic = function() {
	if (!window.__aListMusicDepsReady || !window.__aListMusicScopeReady || window.vueApp) return;
	let currTimeFlag = Date.now();
	window.vueApp = Vue.createApp({
		mixins: [mixin],
		data() {
					return {
						isAList: true, // 纯 AList 模式（已移除云音乐/网易云播放模式）
						isMobile: window.innerWidth < 768,
						options: searchOptions,
						playMode: 'loop',
						searchKeyword: '',
						selectedSource: searchOptions[0].v,
						searchResults: [],
						lyricHistory: {},
						currentSong: {
							title: '',
							artist: '',
							cover: ''
						},
						isPlaying: false,
						currentTime: 0,
						totalTime: 0,
						progress: 0,
						volume: getStorageExp('dm_volume') ?? 80,
						lyrics: [],
						currentLyricIndex: -1,
						lyricFontSize: (() => {
							const savedFontSize = Number(getStorageExp(cacheKey.fontSize));
							if (window.innerWidth < 800) return !Number.isFinite(savedFontSize) || savedFontSize === 18 ? 16 : Math.min(savedFontSize, 52);
							return Math.min(!Number.isFinite(savedFontSize) || savedFontSize === 46 ? 44 : savedFontSize, 52);
						})(),
						lyricsEnd: null,
						lyricLock: true,
						lyricFull: false,
						fullPlaylistVisible: false,
						lyricSwitching: false,
						endingSong: false,
						historyTime: 0,
						pendingRestore: null,
						restoredPlayback: false,
						albumSbgImg,
						safeCoverUrl: albumSbgImg,
						fullVolumeVisible: false,
						lyricLoading: false,
						lyricLoadingMsg: '',
						_coverColorCache: {},
						fullCoverColors: null,
						randomIndexes: [],
						randomListKey: '',
					};
				},
				computed: {
					volumeIconClass() {
						if (this.volume === 0) return 'cursor fas fa-volume-mute volume-icon';
						if (this.volume < 50) return 'cursor fas fa-volume-down volume-icon';
						return 'cursor fas fa-volume-up volume-icon';
					},
					lyricSectionStyle() {
						const base = { 'font-size': (this.lyricFull ? this.lyricFontSize : 16) + 'px' };
						if (!this.lyricFull) return base;
						return Object.assign(base, this.fullSectionBgStyle);
					},
					fullBgStyle() {
						const url = this.safeCoverUrl || albumSbgImg;
						return { backgroundImage: `url(${url})` };
					},
					fullSectionBgStyle() {
						const cols = this.fullCoverColors;
						if (!cols || !cols.dominant) {
							return {
								'--full-accent': '#ff7474',
								background: `linear-gradient(175deg, #0f1419 0%, #131921 35%, #11161d 70%, #0c1017 100%), #0d1117`
							};
						}
						const d = cols.dominant;
						const a = cols.accent;
						// RGB→HSL 转换
						const rgb2hsl = (c) => {
							const r = c.r/255, g = c.g/255, b = c.b/255;
							const max = Math.max(r,g,b), min = Math.min(r,g,b);
							const l = (max+min)/2;
							if (max===min) return {h:0, s:0, l};
							const d2 = max-min;
							const s = l>0.5 ? d2/(2-max-min) : d2/(max+min);
							let h;
							switch(max){
								case r: h=((g-b)/d2+(g<b?6:0))/6; break;
								case g: h=((b-r)/d2+2)/6; break;
								case b: h=((r-g)/d2+4)/6; break;
							}
							return {h: h*360, s, l};
						};
						const hsl2rgb = (hsl) => {
							const h=hsl.h/360, s=hsl.s, l=hsl.l;
							if(s===0) return {r:Math.round(l*255),g:Math.round(l*255),b:Math.round(l*255)};
							const hue2rgb = (p,q,t) => {if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;};
							const q = l<0.5 ? l*(1+s) : l+s-l*s;
							const p = 2*l - q;
							return {r:Math.round(hue2rgb(p,q,h+1/3)*255),g:Math.round(hue2rgb(p,q,h)*255),b:Math.round(hue2rgb(p,q,h-1/3)*255)};
						};
						const toRgba = (c, a) => `rgba(${c.r},${c.g},${c.b},${a})`;

						// 从主色衍生：高饱和高亮变体
						const dhsl = rgb2hsl(d);
						const vivid = hsl2rgb({h: dhsl.h, s: Math.min(1, dhsl.s * 1.3), l: 0.42});
						const glow = hsl2rgb({h: dhsl.h, s: Math.min(1, dhsl.s * 1.1), l: 0.28});
						const deep = hsl2rgb({h: dhsl.h, s: dhsl.s * 0.8, l: 0.12});

						// 从辅色衍生：弱光晕
						const ahsl = rgb2hsl(a);
						const aGlow = hsl2rgb({h: ahsl.h, s: Math.min(1, ahsl.s * 1.2), l: 0.35});

						return {
							'--full-accent': toRgba(vivid, 1),
							background: [
								// 左上主光斑 — 大面鲜艳
								`radial-gradient(ellipse 55% 45% at 25% 20%, ${toRgba(vivid, 0.55)}, transparent 55%)`,
								// 右下辅色光晕
								`radial-gradient(ellipse 50% 40% at 72% 65%, ${toRgba(aGlow, 0.35)}, transparent 50%)`,
								// 中心微弱亮区
								`radial-gradient(ellipse 40% 35% at 48% 42%, ${toRgba(glow, 0.22)}, transparent 48%)`,
								// 深色底色 — 仅底部渐深保证文字可读
								`linear-gradient(175deg, ${toRgba(deep, 0.25)} 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.35) 100%)`,
								// 纯色兜底 — 填充所有透明间隙
								`#0d1117`
							].join(', ')
						};
					},
					currIndSh() {
						return this.searchResults.length ? this.searchResults.findIndex(x => `${x.source}_${x.id}` ===
							this.currentSong.key) : -1;
					},
					currentDownloadTarget() {
						if (!this.currentSong.key) return null;
						return this.currIndSh !== -1 ? {
							ind: this.currIndSh,
							isSearch: true
						} : null;
					},
					canDownloadCurrent() {
						return !!this.currentDownloadTarget;
					},
					fullSongList() {
						return this.searchResults;
					},
					fullSongListTitle() {
						return '当前曲库';
					},
					fullDisplayInfo() {
						return this.parseSongDisplayInfo(this.currentSong.raw || this.currentSong);
					},
					fullDisplayTitle() {
						return this.fullDisplayInfo.title;
					},
					fullDisplayArtist() {
						return this.fullDisplayInfo.artist;
					},
					displayCoverUrl() {
						return this.safeCoverUrl !== albumSbgImg ? this.safeCoverUrl : (this.currentSong.cover || albumSbgImg);
					},
					bgImageUrl() {
						const url = this.safeCoverUrl !== albumSbgImg ? this.safeCoverUrl : (this.currentSong.cover || albumSbgImg);
						return url && url !== albumSbgImg ? url : null;
					},
					bgCoverStyle() {
						const url = this.bgImageUrl;
						return url
							? { backgroundImage: `url(${url})`, opacity: 1 }
							: { opacity: 0 };
					},
				},
				methods: {
					parseSongDisplayInfo(song) {
						if (!song) return {
							title: '',
							artist: ''
						};
						const rawName = (song.name || song.title || '').trim();
						const cleanName = rawName.replace(/\.[^.]+$/, '').trim();
						const rawArtist = this.formatSongSubtitle(song).trim();
						const match = cleanName.match(/^(.+?)\s*-\s*(.+)$/);
						if (match) {
							return {
								artist: match[1].trim(),
								title: match[2].trim()
							};
						}
						return {
							title: cleanName || rawName || '暂无歌曲',
							artist: rawArtist
						};
					},
					formatPlaylistTitle(song) {
						return this.parseSongDisplayInfo(song).title || (song && song.name) || '暂无歌曲';
					},
					formatPlaylistArtist(song) {
						return this.parseSongDisplayInfo(song).artist;
					},
					formatSongSubtitle(song) {
						if (!song) return '';
						const rawArtist = Array.isArray(song.artist) ? song.artist.join(' / ') : (song.artist || '');
						if (!rawArtist) return '';
						if (/^\s*\/[^ ]*/.test(rawArtist)) {
							// AList路径，提取最后一级目录名
							const parts = rawArtist.replace(/^\//, '').split('/');
							const last = parts[parts.length - 1];
							return last || '';
						}
						return rawArtist;
					},
					refreshSafeCoverUrl(url) {
						const candidate = url || albumSbgImg;
						this.safeCoverUrl = albumSbgImg;
						if (!candidate || candidate === albumSbgImg) return;
						const token = (this._coverLoadToken = (this._coverLoadToken || 0) + 1);
						const img = new Image();
						let finished = false;
						const finish = (ok) => {
							if (finished) return;
							finished = true;
							if (this._coverLoadToken !== token) return;
							this.safeCoverUrl = ok ? candidate : albumSbgImg;
						};
						img.onload = () => finish(true);
						img.onerror = () => finish(false);
						img.src = candidate;
						setTimeout(() => finish(false), 3500);
					},
					handleCoverError() {
						this.safeCoverUrl = albumSbgImg;
						if (this.currentSong && this.currentSong.cover !== albumSbgImg) {
							this.currentSong = {
								...this.currentSong,
								cover: albumSbgImg
							};
						}
					},
														_fetchCoverColors(url) {
				const token = (this._coverColorToken = (this._coverColorToken || 0) + 1);
							const isCurrent = () => this._coverColorToken === token && this.lyricFull && this.displayCoverUrl === url;
							if (!url || url === albumSbgImg) {
								this.fullCoverColors = null;
								return;
							}
							if (this._coverColorCache[url]) {
								if (isCurrent()) this.fullCoverColors = this._coverColorCache[url];
								return;
							}
							this.fullCoverColors = null;
							const img = new Image();
							img.crossOrigin = 'anonymous';
							img.onload = () => {
								try {
									const canvas = document.createElement('canvas');
									canvas.width = 60; canvas.height = 60;
									const ctx = canvas.getContext('2d');
									ctx.drawImage(img, 0, 0, 60, 60);
									const data = ctx.getImageData(0, 0, 60, 60).data;
									const half = 30;
									const sample = (x0, y0, x1, y1) => {
										let r = 0, g = 0, b = 0, count = 0;
										for (let y = y0; y < y1; y++) {
											for (let x = x0; x < x1; x++) {
												const i = (y * 60 + x) * 4;
												const pr = data[i], pg = data[i + 1], pb = data[i + 2];
												const sum = pr + pg + pb;
												if (sum < 50 || sum > 720) continue;
												const maxC = Math.max(pr, pg, pb), minC = Math.min(pr, pg, pb);
												const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;
												const w = 0.5 + saturation * 2;
												r += pr * w; g += pg * w; b += pb * w; count += w;
											}
										}
										return count > 0 ? { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) } : null;
									};
									const dominant = sample(0, 0, 60, half) || sample(0, 0, 60, 60);
									const accent = sample(half, half, 60, 60) || sample(half, 0, 60, half);
									if (dominant) {
										const cols = { dominant, accent: accent || dominant };
										this._coverColorCache[url] = cols;
										if (isCurrent()) this.fullCoverColors = cols;
									}
																				} catch (error) {
						this.fullCoverColors = null;
					}
				};
				img.onerror = () => {
					if (isCurrent()) this.fullCoverColors = null;
				};
				img.src = url;
			},
					persistPlaybackState() {
						if (!this.currentSong || !this.currentSong.key) return;
						const audio = this.$refs.audioPlayer;
						const time = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : this.currentTime;
						const ind = this.currIndSh;
						if (ind < 0) return;
						const state = { key: this.currentSong.key, ind, time: Math.max(0, time || 0) };
						setStorageExp(cacheKey.playbackState, state);
						setStorageExp(cacheKey.currInd, state.ind);
						setStorageExp(cacheKey.currTime, state.time);
						setStorageExp(cacheKey.playbackSongKey, state.key);
					},
					tryRestorePlayback() {
						if (this.restoredPlayback || !this.pendingRestore) return;
						const { key, time, isSearch } = this.pendingRestore;
						const list = this.searchResults;
						if (!Array.isArray(list) || !key) return;
						const keyIndex = list.findIndex(song => `${song.source}_${song.id}` === key);
						if (keyIndex < 0) return;
						this.restoredPlayback = true;
						this.pendingRestore = null;
						this.playSong(keyIndex, isSearch, time || 0, false, true);
					},
					reloadCurrentSong(isForce = true, forcePlay = false, preserveRetry = false) {
						const source = this.getPlaybackSource();
						if (source.cur < 0 || source.cur >= source.len) {
							return this.showNotification('请先选择要播放的歌曲', 'warning');
						}
						const resumeTime = this.$refs.audioPlayer ? this.$refs.audioPlayer.currentTime : 0;
						const shouldPlay = forcePlay || this.isPlaying;
						this.playSong(source.cur, source.isSearch, resumeTime, isForce, shouldPlay, !shouldPlay, forcePlay, preserveRetry);
					},
					getCurrentQueueSong() {
						if (this.currIndSh >= 0 && this.currIndSh < this.searchResults.length) {
							return this.searchResults[this.currIndSh];
						}
						if (this.currentSong && this.currentSong.raw && this.currentSong.raw.id && this.currentSong.raw.source) {
							return this.currentSong.raw;
						}
						return null;
					},
					reloadCurrentLyrics() {
						const song = this.getCurrentQueueSong();
						if (!song) {
							return this.showNotification('请先选择要播放的歌曲', 'warning');
						}
						return this.loadLyrics(song, true);
					},
														applySeekTime(time) {
				const audio = this.$refs.audioPlayer;
				if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
				audio.currentTime = Math.min(Math.max(time, 0), audio.duration);
				this.historyTime = null;
				this.progress = (audio.currentTime / audio.duration) * 100;
				this.currentTime = audio.currentTime;
				this.updateLyricHighlight();
			},
					handleAudioPlay() {
						this.isPlaying = true;
					},
					handleAudioError(e) {
						const activeMedia = this._activeMedia;
						const eventSrc = e && e.currentTarget && (e.currentTarget.currentSrc || e.currentTarget.src);
						if (!activeMedia || activeMedia.playToken !== this._playSongToken || activeMedia.key !== this.currentSong.key) return;
						if (eventSrc && eventSrc !== activeMedia.src) return;
						if (activeMedia.errorHandled) return;
						activeMedia.errorHandled = true;
						const error = this.$refs.audioPlayer.error;
						const errorCode = error && error.code;
						if (errorCode === MediaError.MEDIA_ERR_ABORTED) return;
						const fallbackUrl = activeMedia.fallbackUrls && activeMedia.fallbackUrls.shift();
						if (fallbackUrl) {
							const audio = this.$refs.audioPlayer;
							const resumeTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
							activeMedia.errorHandled = false;
							audio.pause();
							audio.removeAttribute('src');
							audio.load();
							audio.src = fallbackUrl;
							activeMedia.src = audio.src;
							audio.load();
							if (resumeTime > 0) this._pendingResume = { playToken: activeMedia.playToken, key: activeMedia.key, time: resumeTime };
							this.showNotification('当前音频地址不可用，正在尝试备用地址...', 'warning', 4);
							audio.play().catch(playError => {
								if (playError && (playError.name === 'AbortError' || playError.name === 'NotSupportedError' && audio.error)) return;
								if (!audio.error) this.stopPlaybackWithError(playError);
							});
							return;
						}
						let msg = '播放出错';
						if (errorCode === MediaError.MEDIA_ERR_NETWORK) msg = '音频网络请求失败，正在重新获取地址...';
						else if (errorCode === MediaError.MEDIA_ERR_DECODE) msg = '音频解码失败，正在重新获取地址...';
						else if (errorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) msg = '音频响应不是浏览器支持的媒体，正在重新获取地址...';
						const shouldRetry = errorCode === MediaError.MEDIA_ERR_NETWORK
							|| errorCode === MediaError.MEDIA_ERR_DECODE
							|| errorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
						if (shouldRetry && this.currentSong && this.currentSong.key) {
							const retryKey = activeMedia.key;
							this._audioErrorRetry ||= {};
							this._audioErrorRetry[retryKey] = (this._audioErrorRetry[retryKey] || 0) + 1;
							if (this._audioErrorRetry[retryKey] <= 2) {
								this.showNotification(`${msg}（第${this._audioErrorRetry[retryKey]}次）`, 'warning', 4);
								this.reloadCurrentSong(true, true, true);
								return;
							}
						}
						this.stopPlaybackWithError(new Error(
							errorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
								? '音频源不可播放。请确认 AList 公网地址使用 HTTPS，并为该存储启用 Web 代理或提供可公开播放的 HTTPS 直链'
								: msg
						));
					},
					handleEnded(e) {
						const audio = this.$refs.audioPlayer;
						const eventSrc = e && e.currentTarget && (e.currentTarget.currentSrc || e.currentTarget.src);
						if (!audio || (this._activeMedia && eventSrc && eventSrc !== this._activeMedia.src)) return;
						if (this.endingSong) return;
						this.endingSong = true;
						this.nextSong(false);
					},
					handleWaiting(e) {
						const eventSrc = e && e.currentTarget && (e.currentTarget.currentSrc || e.currentTarget.src);
						if (this._activeMedia && eventSrc && eventSrc !== this._activeMedia.src) return;
						if (!this._stallTimer) {
							this._stallTimer = setTimeout(() => {
								this._stallTimer = null;
								if (this.isPlaying && this.$refs.audioPlayer.paused && this.$refs.audioPlayer.src) {
									this.$refs.audioPlayer.play().catch(() => {
										// 防止循环重试：记录该URL已失败，避免重复reload
										const src = this.$refs.audioPlayer.src;
										if (src && this._lastStalledSrc !== src) {
											this._lastStalledSrc = src;
											this.showNotification('音频缓冲超时，尝试重新加载', 'warning');
											this.reloadCurrentSong(true, true, true);
										}
									});
								}
							}, 5000);
						}
					},
														prefersReducedMotion() {
				return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			},
			goTo(selector) {
				const target = document.querySelector(selector);
				if (target) target.scrollIntoView({
					behavior: this.prefersReducedMotion() ? 'auto' : 'smooth',
					block: 'end'
				});
			},
			toggleLyricFull() {
				if (this.lyricFull) return this.exitLyricFull();
				this._fullscreenPreviousFocus = document.activeElement;
				this.lyricFull = true;
				this.$nextTick(() => this.$refs.fullExitButton && this.$refs.fullExitButton.focus());
			},
			exitLyricFull() {
							this.closeFullOverlays(false);
							this.lyricFull = false;
							this.$nextTick(() => {
								const target = this._fullscreenPreviousFocus;
								if (target && document.contains(target)) target.focus();
								this._fullscreenPreviousFocus = null;
							});
						},
						closeFullOverlays(restorePlaylistFocus = false) {
							this.closeFullVolume();
							if (this.fullPlaylistVisible) this.closeFullPlaylist(restorePlaylistFocus);
						},
						toggleFullVolume() {
							if (!this.lyricFull) return;
							if (this.fullPlaylistVisible) this.closeFullPlaylist(false);
							this.fullVolumeVisible = !this.fullVolumeVisible;
						},
						closeFullVolume() {
							this.fullVolumeVisible = false;
						},
						toggleFullPlaylist() {
							if (!this.lyricFull) return;
							if (this.fullPlaylistVisible) return this.closeFullPlaylist();
							this.closeFullVolume();
							this.fullPlaylistVisible = true;
							this.$nextTick(() => {
								const activeItem = this.$refs.fullPlaylistPanel && this.$refs.fullPlaylistPanel.querySelector('.full-playlist-item.active');
								(activeItem || this.$refs.fullPlaylistClose)?.focus();
							});
						},
						closeFullPlaylist(restoreFocus = true) {
							if (!this.fullPlaylistVisible) return;
							this.fullPlaylistVisible = false;
							if (restoreFocus) this.$nextTick(() => this.$refs.fullPlaylistToggle && this.$refs.fullPlaylistToggle.focus());
						},
						trapFullPlaylistFocus(e) {
							const panel = this.$refs.fullPlaylistPanel;
							if (!panel) return;
							const items = Array.from(panel.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
							if (!items.length) return;
							const first = items[0];
							const last = items[items.length - 1];
							if (e.shiftKey && document.activeElement === first) {
								e.preventDefault();
								last.focus();
							} else if (!e.shiftKey && document.activeElement === last) {
								e.preventDefault();
								first.focus();
							}
						},
						playFullSong(index) {
							this.playSong(index, true);
							this.closeFullPlaylist();
						},
					refresh: refreshBind,
					sourceChange: sourceChangeBind,
					uploadLyric: uploadLyricBind,
					toTopList(isSearch) {
						if (isSearch === true) {
															document.querySelector('#searchResults').scrollTo({
									top: 0,
									behavior: this.prefersReducedMotion() ? 'auto' : 'smooth'
								})
						}
					},
					focusList(isSearch) {
						if (isSearch === true) {
							const el = document.querySelector('#searchResults .song-item.active');
							if (el) el.scrollIntoView({
								behavior: this.prefersReducedMotion() ? 'auto' : 'smooth',
								block: 'center'
							});
						} else {
							// 定位当前歌词行
							this.scrollToActiveLyric();
						}
					},
					// 列表自动跟随当前歌曲：与"定位当前歌曲"按钮一致（居中），并避免移动端页面跳转
					scrollFollowSong() {
						if (this.lyricFull) return;
						const container = document.querySelector('#searchResults');
						if (!container) return;
						const el = container.querySelector('.song-item.active');
						if (!el) return;
						const cRect = container.getBoundingClientRect();
						const vh = window.innerHeight || document.documentElement.clientHeight;
						// 容器基本完整可见（桌面三列/移动端列表区已就位）：scrollIntoView 会强制渲染目标项，定位最准，且不会滚动页面
						if (cRect.top >= 0 && cRect.bottom <= vh) {
															el.scrollIntoView({ behavior: this.prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
							return;
						}
						// 容器仅部分可见（移动端滚动到列表区途中）：强制渲染目标项拿到真实高度，再手动居中内部容器，避免页面被拽走
						const prev = el.style.contentVisibility;
						el.style.contentVisibility = 'visible';
						const eRect = el.getBoundingClientRect();
						const eH = el.offsetHeight;
						el.style.contentVisibility = prev;
						const eTop = eRect.top - cRect.top + container.scrollTop;
						const target = Math.max(0, eTop - container.clientHeight / 2 + eH / 2);
													container.scrollTo({ top: target, behavior: this.prefersReducedMotion() ? 'auto' : 'smooth' });
					},
					async searchMusic() {
						toggleLoading(true);
						try {
							await searchMusicBind.call(this, this.searchKeyword, this.selectedSource)
						} catch (error) {
							this.showNotification('网络连接失败，请检查网络后重试', 'error');
						} finally {
							toggleLoading();
						}
					},
					getPlaybackSource() {
						return {
							isSearch: true,
							cur: this.currIndSh,
							len: this.searchResults.length
						};
					},
					ensureRandomIndexes(len, cur) {
						if (!len) return [];
						// 列表内容变化（新搜索）时重新洗牌：randomListKey 由 searchMusicBind 维护
						const listKey = this.getRandomListKey();
						if (!this.randomIndexes || this.randomIndexes.length !== len || this.randomIndexes.some(x => x >= len) || listKey !== this.randomListKey) {
							this.randomIndexes = genRandomIndexes(len);
							this.randomListKey = listKey;
						}
						if (cur !== -1 && !this.randomIndexes.includes(cur)) this.randomIndexes = genRandomIndexes(len);
						return this.randomIndexes;
					},
					getRandomListKey() {
						return this.searchResults.map(song => `${song.source}_${song.id}`).join('|');
					},
					async searchOnlineLyric(song) {
						const cleanName = (song.name || '').replace(/\.[^./\\]+$/, '');
						const results = await getNetEaseSearch(cleanName, 1).catch(() => null);
						if (!results || !results.length) return null;
						const match = results[0];
						return getNetEaseLyric(match.lyric_id || match.id);
					},
			preloadSongAssets(song) {
				if (!song) return;
				const key = `${song.source}_${song.id}`;
				getAlbumCoverUrl(song).catch(() => {});
				if (this.lyricHistory[key]) return;
				// 尝试预加载歌词：本地LRC优先，无则在线搜索网易云
				(async () => {
					let lyric = await getSongLyric(song).catch(() => null);
					if (!lyric) lyric = await this.searchOnlineLyric(song).catch(() => null);
					if (!lyric || this.lyricHistory[key]) return;
					this.lyricHistory[key] = lyric;
					setStorage(cacheKey.lyricHistory, this.lyricHistory);
				})().catch(() => {});
			},
					preloadQueueNeighbors(ind) {
						const list = this.getCurrentPlayList();
						const len = list.length;
						if (!len) return;
						this.preloadSongAssets(list[(ind + 1) % len]);
						if (len > 2) this.preloadSongAssets(list[(ind - 1 + len) % len]);
					},
					// 当前播放列表
					getCurrentPlayList() {
						return this.searchResults;
					},
					async playSong(ind, isSearch, time = 0, isForce, autoResume = false, suppressAutoPlay = false, forcePlay = false, preserveRetry = false) {
						const list = this.getCurrentPlayList();
						if (ind < 0 || ind >= list.length) return;
						const playToken = (this._playSongToken = (this._playSongToken || 0) + 1);
						const song = list[ind];
						let key = `${song.source}_${song.id}`
						if (this.currentSong.key === key && !isForce) return;
						this._audioErrorRetry ||= {};
						if (!preserveRetry) this._audioErrorRetry[key] = 0;
						// 注意：此处不重置 endingSong —— 自动切歌时它保持 true，防止 URL 获取期间
						// timeupdate 再次触发 nextSong 导致连跳；新歌 src 就绪后再重置（见下方）
						this._pendingResume = null;
						setStorageExp(cacheKey.currInd, ind);
						setStorageExp(cacheKey.currTime, time > 0 ? time : 0);
						setStorageExp(cacheKey.playbackSongKey, key);
						// 更新当前歌曲信息
						const displayInfo = this.parseSongDisplayInfo(song);
						const rawArtist = Array.isArray(song.artist) ? song.artist.join(' / ') : (song.artist || '');
						const artistText = (displayInfo.artist || rawArtist) + (song.album ? (' · ' + song.album) : '');
						this.currentSong = {
							key,
							id: song.id,
							source: song.source,
							title: displayInfo.title,
							lyric: song.lyric,
							raw: { ...song },
							artist: artistText,
							cover: albumSbgImg
						};
						this.loadCover(song);
						const lyricPromise = this.loadLyrics(song);
						try {
							this.showNotification('正在加载音乐...', 'info');
							const mediaSource = await getSongUrl(song);
							const songUrl = typeof mediaSource === 'string' ? mediaSource : mediaSource && mediaSource.url;
							const fallbackUrls = mediaSource && Array.isArray(mediaSource.fallbackUrls) ? mediaSource.fallbackUrls : [];
							if (this._playSongToken !== playToken || this.currentSong.key !== key) return;
							if (!songUrl) {
								this._lyricLoadToken = (this._lyricLoadToken || 0) + 1;
								return this.stopPlaybackWithError(new Error('AList 未返回可用的音频地址'));
							}
							const audio = this.$refs.audioPlayer;
							audio.pause();
							audio.removeAttribute('src');
							audio.load();
							audio.src = songUrl;
							this._activeMedia = {
								playToken,
								key,
								src: audio.src,
								fallbackUrls,
								errorHandled: false
							};
							this.endingSong = false;
							this.historyTime = time
							this.progress = 0;
							this.currentTime = 0;
							this.totalTime = 0;
							this.$refs.audioPlayer.load();
							if (autoResume && time > 0) {
								this._pendingResume = { playToken, key, time };
							}
							lyricPromise.finally(() => {
								if (this._playSongToken === playToken && this.currentSong.key === key) {
									this.preloadQueueNeighbors(ind);
								}
							}).catch(() => {});
							// 自动播放
							if ((!this.historyTime || forcePlay) && !suppressAutoPlay) this.$refs.audioPlayer.play().then(() => {
								if (this._playSongToken !== playToken || this.currentSong.key !== key) return;
								this.showNotification(`开始播放 ${artistText} · ${displayInfo.title}`, 'success');
							}).catch((error) => {
								if (this._playSongToken !== playToken || this.currentSong.key !== key) return;
								if (error && (error.name === 'AbortError' || error.name === 'NotSupportedError' && this.$refs.audioPlayer.error)) return;
								if (error && error.name === 'NotAllowedError') {
									this.showNotification('浏览器阻止了自动播放，请再次点击播放按钮', 'warning', 5);
									return;
								}
								if (!this.$refs.audioPlayer.error) this.stopPlaybackWithError(error);
							});
						} catch (error) {
							if (this._playSongToken !== playToken || this.currentSong.key !== key) return;
							this._lyricLoadToken = (this._lyricLoadToken || 0) + 1;
							return this.stopPlaybackWithError(error);
						}
					},
					stopPlaybackWithError(error) {
						this.isPlaying = false;
						this.endingSong = false;
						this._pendingResume = null;
						if (this._audioErrorRetry && this.currentSong && this.currentSong.key) {
							this._audioErrorRetry[this.currentSong.key] = 0;
						}
						this._activeMedia = null;
						if (this.$refs.audioPlayer) {
							this.$refs.audioPlayer.pause();
							this.$refs.audioPlayer.removeAttribute('src');
							this.$refs.audioPlayer.load();
						}
						const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
						const message = offline
							? '网络不可用，已停止播放，请检查网络连接'
							: (error && error.message ? error.message : '无法加载音频，请检查 AList 公网访问和存储代理配置');
						return this.showNotification(message, 'error', 8);
					},
					toggleMode() {
						this.playMode = this.playMode === 'loop' ? 'random' : this.playMode === 'random' ? 'one' :
							'loop';
						if (this.playMode === 'random') {
							const source = this.getPlaybackSource();
							this.ensureRandomIndexes(source.len, source.cur);
						}
						const modeName = { loop: '列表循环', random: '随机播放', one: '单曲循环' }[this.playMode] || this.playMode;
						this.showNotification('切换播放模式为' + modeName, 'info')
						setStorageExp(cacheKey.playMode, this.playMode);
						// 切换模式后按新模式重新预加载候选 URL，保证随机模式切歌零等待
						const cur = this.currIndSh;
						if (cur >= 0) this.preloadQueueNeighbors(cur);
					},
					togglePlay() {
						if (!this.$refs.audioPlayer.src) return this.showNotification('请先选择要播放的歌曲', 'warning')
						if (this.isPlaying) {
							this.$refs.audioPlayer.pause();
						} else {
							if (this.historyTime) {
								this.$refs.audioPlayer.currentTime = this.historyTime;
								this.historyTime = null;
							}
							this.$refs.audioPlayer.play().catch((error) => {
								if (error && (error.name === 'AbortError' || error.name === 'NotSupportedError' && this.$refs.audioPlayer.error)) return;
								if (error && error.name === 'NotAllowedError') {
									this.showNotification('浏览器阻止了播放，请再次点击播放按钮', 'warning', 5);
									return;
								}
								if (!this.$refs.audioPlayer.error) this.stopPlaybackWithError(error);
							});
						}
					},
					prevSong() {
						this.endingSong = false;
						const source = this.getPlaybackSource();
						let cur = source.cur, len = source.len;
						if (!len) return;
						if (cur < 0) cur = 0;
						let ind = cur > 0 ? cur - 1 : len - 1;
						if (this.playMode === 'random') {
							const randomIndexes = this.ensureRandomIndexes(len, cur);
							let randomInd = randomIndexes.indexOf(cur);
							if (randomInd < 0) randomInd = 0;
							ind = randomIndexes[randomInd > 0 ? randomInd - 1 : randomIndexes.length - 1];
						}
						this.playSong(ind, source.isSearch);
					},
					nextSong(isManual) {
						if (isManual === false && this.playMode === 'one') {
							this.$refs.audioPlayer.currentTime = 0;
							this.endingSong = false;
							return this.$refs.audioPlayer.play();
						}
						if (isManual !== false) this.endingSong = false;
						const source = this.getPlaybackSource();
						let cur = source.cur,
							len = source.len;
						if (!len) return;
						if (len === 1) {
							// 单首列表：重播当前歌曲，避免播完即停（loop/one/手动均重播）
							this.$refs.audioPlayer.currentTime = 0;
							this.endingSong = false;
							if (this.$refs.audioPlayer.paused) this.$refs.audioPlayer.play().catch(() => {});
							return;
						}
						if (cur < 0) cur = -1;
						let ind = (cur + 1) % len;
						if (this.playMode === 'random') {
							const randomIndexes = this.ensureRandomIndexes(len, cur);
							const randomInd = randomIndexes.indexOf(cur);
							ind = randomIndexes[((randomInd < 0 ? -1 : randomInd) + 1) % randomIndexes.length];
						}
						this.playSong(ind, source.isSearch);
					},
					seekToLyric(time) {
						if (this.lyricLock) return
						this.applySeekTime(time);
					},
					setVolume(value, isMute) {
						if (isMute) {
							value = value > 0 ? 0 : 80;
							this.volume = value;
						}
						this.$refs.audioPlayer.volume = value / 100;
						setStorageExp('dm_volume', value);
					},
					updateProgress() {
						if (this.$refs.audioPlayer.duration) {
							const audio = this.$refs.audioPlayer;
							this.progress = (this.$refs.audioPlayer.currentTime / this.$refs.audioPlayer.duration) * 100;
							this.currentTime = this.$refs.audioPlayer.currentTime;
							if (this.currentSong.key && this.currentTime >= 1 && this._audioErrorRetry) {
								this._audioErrorRetry[this.currentSong.key] = 0;
							}
							this.updateLyricHighlight();
							if (!this.endingSong && !audio.paused && audio.duration - audio.currentTime <= 0.35) {
								this.endingSong = true;
								return this.nextSong(false);
							}
							if (Date.now() - currTimeFlag < 1500) return; // 1.5s同步一次
							currTimeFlag = Date.now();
							setStorageExp(cacheKey.currTime, this.currentTime);
							setStorageExp(cacheKey.playbackSongKey, this.currentSong.key);
						}
					},
					updateTotalTime() {
						this.totalTime = this.$refs.audioPlayer.duration;
						// 处理恢复播放时的 seek
						if (this._pendingResume) {
							const { playToken, key, time } = this._pendingResume;
							if (this._playSongToken === playToken && this.currentSong.key === key) {
								this._pendingResume = null;
								this.applySeekTime(time);
								this.$refs.audioPlayer.play().catch((e) => {
									console.error('resume play error', e);
								});
							}
						}
					},
			async loadCover(song) {
						if (!song) return;
						const key = `${song.source}_${song.id}`;
						const token = (this._coverRequestToken = (this._coverRequestToken || 0) + 1);
						let cover = null;
						// 最多重试2次
						for (let attempt = 0; attempt < 3; attempt++) {
							try {
								cover = await getAlbumCoverUrl(song);
								if (cover && cover !== albumSbgImg) break;
							} catch (e) {
								console.warn(`封面获取失败(第${attempt + 1}次):`, e);
							}
							if (attempt < 2) await new Promise(r => setTimeout(r, 500));
						}
						if (this._coverRequestToken !== token || (this.currentSong.key && this.currentSong.key !== key)) return;
						this.currentSong.cover = cover || albumSbgImg;
					},
					async loadLyrics(song, isForce) {
						song = song && song.raw ? song.raw : song;
						if ((!song || !song.id || !song.source) && this.currIndSh >= 0 && this.currIndSh < this.searchResults.length) {
							song = this.searchResults[this.currIndSh];
						}
						if (!song || !song.id || !song.source) return;
						const key = `${song.source}_${song.id}`;
						const token = (this._lyricLoadToken = (this._lyricLoadToken || 0) + 1);
						const cachedLyric = this.lyricHistory[key] || null;
						// 强制刷新：清空旧歌词，重新获取
						if (isForce) {
							this.lyrics = [];
							this.currentLyricIndex = -1;
							this.lyricsEnd = null;
							this.lyricLoading = true;
							this.lyricLoadingMsg = '正在搜索歌词...';
						} else if (this._lyricSongKey !== key) {
							// 切歌：清空旧歌词
							this._lyricSongKey = key;
							this.lyrics = [];
							this.currentLyricIndex = -1;
							this.lyricsEnd = null;
						}
						// 非强制且有缓存：直接用缓存
						if (cachedLyric && !isForce) {
							if (this.currentSong.key && this.currentSong.key !== key) return;
							return this.parseLyrics(cachedLyric);
						}

						try {
							let lyric = null;
				if (isForce) {
							// 强制刷新：在线搜索网易云歌词
							lyric = await this.searchOnlineLyric(song);
							if (this._lyricLoadToken !== token || (this.currentSong.key && this.currentSong.key !== key)) return;
							if (lyric) {
								this.lyricLoading = false;
								this.lyricHistory[key] = lyric;
								setStorage(cacheKey.lyricHistory, this.lyricHistory);
								this.parseLyrics(lyric);
							} else {
								this.lyricLoading = false;
								this.lyrics = [];
								this.showNotification('未获取到此歌曲歌词，请尝试其他歌曲', 'warning');
							}
							return;
						}
						// 自动模式：本地LRC优先，无则在线搜索网易云
						this.lyricLoading = true;
						this.lyricLoadingMsg = '正在获取歌词...';
						lyric = await getSongLyric(song);
						if (this._lyricLoadToken !== token || (this.currentSong.key && this.currentSong.key !== key)) return;
						// AList 无本地 LRC：自动搜索网易云在线歌词
						if (!lyric) {
							this.lyricLoadingMsg = '正在在线搜索歌词...';
							lyric = await this.searchOnlineLyric(song);
						}
						if (this._lyricLoadToken !== token || (this.currentSong.key && this.currentSong.key !== key)) return;
							if (lyric) {
								this.lyricLoading = false;
								this.lyricHistory[key] = lyric;
								setStorage(cacheKey.lyricHistory, this.lyricHistory);
								this.parseLyrics(lyric);
							} else if (cachedLyric) {
								this.lyricLoading = false;
								this.parseLyrics(cachedLyric);
							} else {
								this.lyricLoading = false;
							}
						} catch (e) {
							console.error('获取歌词失败:', e);
							if (this._lyricLoadToken !== token || (this.currentSong.key && this.currentSong.key !== key)) return;
							this.lyricLoading = false;
							if (cachedLyric) {
								this.parseLyrics(cachedLyric);
							}
						}
					},
					parseLyrics(lrcText) {
						this.lyrics = AppCore.parseLrc(lrcText);
						this.lyricsEnd = this.lyrics.length ? this.lyrics[this.lyrics.length - 1].time : null;
					},
					updateLyricHighlight() {
						const currentTime = this.$refs.audioPlayer.currentTime;
						let activeIndex = -1;

						for (let i = 0; i < this.lyrics.length; i++) {
							if (this.lyrics[i].time <= currentTime) {
								activeIndex = i;
							} else {
								break;
							}
						}
						if (activeIndex === this.currentLyricIndex) return;
						this.currentLyricIndex = activeIndex;
						if (!this.lyricLock) return;

						this.scrollToActiveLyric();
					},
					scrollToActiveLyric() {
						if (this.currentLyricIndex >= 0 && this.$refs.lyricsContainer) {
							const container = this.$refs.lyricsContainer;
							const activeLine = container.children[this.currentLyricIndex];
							if (!activeLine) return;

							const containerHeight = container.clientHeight;
							const lineHeight = activeLine.offsetHeight;
							const lineOffsetTop = activeLine.offsetTop;

																															const readingPosition = this.lyricFull ? 0.44 : 0.5;
								const targetScrollTop = Math.max(0, lineOffsetTop - containerHeight * readingPosition + lineHeight / 2);
								// Edge 下跳过 rAF 平滑滚动，减少 DevTools 打开时的渲染冲突
								if (this.lyricSwitching || this.prefersReducedMotion() || /Edg\//.test(navigator.userAgent)) {
								container.scrollTop = targetScrollTop;
								return;
							}
							const currentScroll = container.scrollTop;
							const distance = Math.abs(targetScrollTop - currentScroll);
							if (distance < 2) {
								container.scrollTop = targetScrollTop;
							} else {
								if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
								const startTime = performance.now();
								const duration = Math.min(350, 150 + distance * 0.3);
								const animate = (now) => {
									const elapsed = now - startTime;
									const progress = Math.min(elapsed / duration, 1);
									const ease = 1 - Math.pow(1 - progress, 3);
									container.scrollTop = currentScroll + (targetScrollTop - currentScroll) * ease;
									if (progress < 1) {
										this.scrollRaf = requestAnimationFrame(animate);
									}
								};
								this.scrollRaf = requestAnimationFrame(animate);
							}
						}
					},
					setFontSize(isBig) {
						this.lyricFontSize = Math.min(72, Math.max(14, this.lyricFontSize + (isBig ? 2 : -2)));
						setStorageExp(cacheKey.fontSize, this.lyricFontSize);
					},
					async downloadSong(ind) {
						if (this._downloadingSong) return this.showNotification('已有音乐正在下载，请稍候', 'info');
						const song = this.searchResults[ind];
						if (!song) return;
						this._downloadingSong = true;
						try {
							this.showNotification('正在准备音乐文件...', 'info');

							const mediaSource = await getSongUrl(song);
							const songUrl = AppCore.sanitizeDownloadUrl(typeof mediaSource === 'string' ? mediaSource : mediaSource && mediaSource.url);
							if (!songUrl) {
								return this.showNotification('未获取到下载地址，请检查网络或 AList 配置', 'error');
							}
							if (location.protocol === 'https:' && /^http:/.test(songUrl)) {
								return this.showNotification('下载地址仅支持 HTTP，请在 AList 中启用 Web 代理或配置 HTTPS 直链', 'error', 8);
							}
							const dlInfo = this.parseSongDisplayInfo(song);
							const extension = AppCore.getFileExtension(song.name) || '.mp3';
							const fileName = `${dlInfo.artist ? `${dlInfo.artist} - ` : ''}${dlInfo.title}${extension}`;
							try {
								const res = await fetch(songUrl, { mode: 'cors' });
								if (!res.ok) throw new Error(`download fetch failed: ${res.status}`);
								const blob = await res.blob();
								const url = URL.createObjectURL(blob);
								const link = Object.assign(document.createElement('a'), {
									href: url,
									download: fileName
								});
								document.body.appendChild(link);
								link.click();
								link.remove();
								setTimeout(() => URL.revokeObjectURL(url), 5000);
								return this.showNotification('音乐文件已开始下载', 'success');
							} catch (error) {
								console.warn('音乐文件 fetch 下载失败，改用浏览器下载入口:', error);
								const link = Object.assign(document.createElement('a'), {
									href: songUrl,
									download: fileName,
									target: '_blank',
									rel: 'noopener noreferrer'
								});
								document.body.appendChild(link);
								link.click();
								link.remove();
								this.showNotification('受跨域限制，已打开音频链接；请在新页面中选择“另存为”', 'info', 6);
							}
						} catch (error) {
							console.error('downloadSong error:', error);
							this.showNotification('音乐下载失败，请检查网络后重试', 'error');
						} finally {
							this._downloadingSong = false;
						}
					},
					async downloadLyric(ind) {
						if (this._downloadingLyric) return this.showNotification('已有歌词正在下载，请稍候', 'info');
						const song = this.searchResults[ind];
						if (!song) return;
						this._downloadingLyric = true;
						try {
							this.showNotification('正在准备歌词文件...', 'info');

							const key = `${song.source}_${song.id}`;
							let lyricContent;
							if (this.lyricHistory[key]) {
								lyricContent = this.lyricHistory[key];
							} else {
								lyricContent = await getSongLyric(song);
							}
							if (!lyricContent) {
																					// AList 无本地LRC：在线搜索网易云歌词
								lyricContent = await this.searchOnlineLyric(song);
							}
							if (!lyricContent) {
								this.showNotification('未找到可下载的歌词', 'warning');
								return;
							}
							const dlInfo = this.parseSongDisplayInfo(song);
							downloadText(
								lyricContent,
								`${dlInfo.artist ? dlInfo.artist + ' - ' : ''}${dlInfo.title}.lrc`
							);
							this.showNotification('歌词文件已下载', 'success');

						} catch (error) {
							this.showNotification('歌词下载失败，请检查网络后重试', 'error');
						} finally {
							this._downloadingLyric = false;
						}
					},
					downloadCurrentSong() {
						if (!this.currentDownloadTarget) {
							this.showNotification('请先选择要下载的歌曲', 'warning');
							return;
						}
						this.downloadSong(this.currentDownloadTarget.ind);
					},
					downloadCurrentLyric() {
						if (!this.currentDownloadTarget) {
							this.showNotification('请先选择要下载歌词的歌曲', 'warning');
							return;
						}
						this.downloadLyric(this.currentDownloadTarget.ind);
					},
					formatTime(seconds) {
						if (!seconds || !isFinite(seconds)) return '0:00';
						const mins = Math.floor(seconds / 60);
						const secs = Math.floor(seconds % 60);
						return `${mins}:${secs.toString().padStart(2, '0')}`;
					},
			showNotification,
			handleKeyDown(e) {
				const inEditable = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName);
				if (e.code === 'Escape' && this.lyricFull) {
					e.preventDefault();
					if (this.fullPlaylistVisible) return this.closeFullPlaylist();
					if (this.fullVolumeVisible) return this.closeFullVolume();
					return this.exitLyricFull();
				}
				if (e.code === 'Space' && !inEditable) {
					e.preventDefault();
					this.togglePlay();
				} else if (e.code === 'ArrowLeft' && !inEditable) {
					e.preventDefault();
					if (e.ctrlKey) return this.prevSong();
					this.historyTime = null;
					this.$refs.audioPlayer.currentTime -= 5
				} else if (e.code === 'ArrowRight' && !inEditable) {
					e.preventDefault();
					if (e.ctrlKey) return this.nextSong();
					this.historyTime = null;
					this.$refs.audioPlayer.currentTime += 5
				} else if (e.key === '0' && !inEditable && e.altKey) {
					e.preventDefault();
					this.toggleLyricFull();
				} else if (e.key === '1' && !inEditable && e.altKey) {
					e.preventDefault();
					this.focusList(true)
				} else if (e.key === '2' && !inEditable && e.altKey) {
					e.preventDefault();
					this.focusList(false)
				} else if ((e.key === '+' || e.key === '=') && !inEditable && this.lyricFull) {
					e.preventDefault();
					this.setFontSize(true)
				} else if (e.key === '-' && !inEditable && this.lyricFull) {
					e.preventDefault();
					this.setFontSize(false)
				}
			},
		},
		watch: {
			searchResults() {
				this.randomIndexes = [];
				this.randomListKey = '';
				this.tryRestorePlayback();
			},
			// 切歌（含随机播放跳转）时让歌曲列表跟随当前歌曲
			'currentSong.key'() {
				if (this.lyricFull) this.closeFullOverlays(false);
				this.$nextTick(() => this.scrollFollowSong());
			},
			safeCoverUrl(url) {
				if (this.lyricFull) this._fetchCoverColors(url);
			},
			lyricFull(val) {
				document.documentElement.classList.toggle('lyric-full-open', val);
				clearTimeout(this._lyricSwitchTimer);
				if (this._lyricLayoutRaf) cancelAnimationFrame(this._lyricLayoutRaf);
				if (!val) {
					this._coverColorToken = (this._coverColorToken || 0) + 1;
					this.fullPlaylistVisible = false;
					this.fullVolumeVisible = false;
				} else {
					this._fetchCoverColors(this.displayCoverUrl);
				}
				this.lyricSwitching = true;
				const syncLyricPosition = () => {
					this.updateLyricHighlight();
					if (this.lyricLock) this.scrollToActiveLyric();
				};
				this.$nextTick(() => {
					this._lyricLayoutRaf = requestAnimationFrame(() => {
						this._lyricLayoutRaf = requestAnimationFrame(() => {
							syncLyricPosition();
							this.lyricSwitching = false;
						});
					});
					this._lyricSwitchTimer = setTimeout(() => {
						syncLyricPosition();
						this.lyricSwitching = false;
					}, 400);
				});
			},
			"currentSong.cover": {
				handler(newCover) {
					this.refreshSafeCoverUrl(newCover);
				},
				immediate: true
			}
		},
				async mounted() {
			AppCore.hideBootStatus();
					this._visibilityHandler = () => {
						if (document.visibilityState === 'hidden') this.persistPlaybackState();
					};
					document.addEventListener('visibilitychange', this._visibilityHandler);
					this.setVolume(this.volume);
					document.addEventListener('keydown', this.handleKeyDown);
					// 移动端判定随窗口变化更新（防抖），适配旋转/分屏/浏览器工具栏收起
								this._resizeHandler = () => {
				clearTimeout(this._resizeTimer);
				this._resizeTimer = setTimeout(() => {
					this.isMobile = window.innerWidth < 768;
				}, 150);
			};
			window.addEventListener('resize', this._resizeHandler);
			if ('ResizeObserver' in window) {
				this._lyricsResizeObserver = new ResizeObserver(() => {
					if (!this.lyricFull || !this.lyricLock) return;
					clearTimeout(this._lyricsResizeTimer);
					this._lyricsResizeTimer = setTimeout(() => this.scrollToActiveLyric(), 80);
				});
				if (this.$refs.lyricsContainer) this._lyricsResizeObserver.observe(this.$refs.lyricsContainer);
			}
			// 歌曲列表进入视口时自动定位到当前歌曲（移动端切换到列表时生效）
					this._songListObserver = new IntersectionObserver((entries) => {
						if (entries.some(e => e.isIntersecting)) {
							this.$nextTick(() => this.scrollFollowSong());
						}
					}, { threshold: 0.05 });
					const songListEl = document.querySelector('#searchResults');
					if (songListEl) this._songListObserver.observe(songListEl);
					const storedLyricHistory = await getStorage(cacheKey.lyricHistory);
					this.lyricHistory = storedLyricHistory && typeof storedLyricHistory === 'object' && !Array.isArray(storedLyricHistory) ? storedLyricHistory : {};
					this.playMode = getStorageExp(cacheKey.playMode) || 'loop';
					if (this.playMode === 'random') this.ensureRandomIndexes(this.searchResults.length, -1);
					this.$nextTick(() => {
						const savedState = getStorageExp(cacheKey.playbackState);
						const currTime = savedState && Number.isFinite(savedState.time) ? savedState.time : getStorageExp(cacheKey.currTime);
																const savedKey = savedState && savedState.key ? savedState.key : getStorageExp(cacheKey.playbackSongKey);
			const savedSongIndex = this.searchResults.findIndex(song => `${song.source}_${song.id}` === savedKey);
			if (savedKey && savedSongIndex >= 0) {
				this.pendingRestore = {
					key: savedKey,
					ind: savedSongIndex,
					time: Math.max(0, currTime || 0),
					isSearch: true
				};
				this.tryRestorePlayback();
				this._restoreTimer = setTimeout(() => this.tryRestorePlayback(), 500);
			}
		});
	},
	beforeUnmount() {
		document.documentElement.classList.remove('lyric-full-open');
		this.persistPlaybackState();
		document.removeEventListener('keydown', this.handleKeyDown);
		clearTimeout(this._resizeTimer);
		clearTimeout(this._lyricsResizeTimer);
		clearTimeout(this._lyricSwitchTimer);
		clearTimeout(this._stallTimer);
		clearTimeout(this._restoreTimer);
		if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
		if (this._lyricLayoutRaf) cancelAnimationFrame(this._lyricLayoutRaf);
		window.removeEventListener('resize', this._resizeHandler);
		document.removeEventListener('visibilitychange', this._visibilityHandler);
		if (this._songListObserver) this._songListObserver.disconnect();
		if (this._lyricsResizeObserver) this._lyricsResizeObserver.disconnect();
	}
	}).mount('#app');
	window.__aListMusicMounted = true;
};
if (window.__aListMusicDepsReady && window.__aListMusicScopeReady) window.__maybeStartAListMusic();

if (/^(https?:)$/.test(location.protocol) && 'serviceWorker' in navigator) {
	window.addEventListener('load', () => {
		navigator.serviceWorker.register('./sw.js?t=9')
			.then(function(registration) {
				registration.update().catch(() => {});
			})
			.catch(function(error) {
				console.error('[SW-DMUSIC] Service Worker failed:', error);
			});
	});
}

