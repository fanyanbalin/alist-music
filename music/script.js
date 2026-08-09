/* ============================================================
   播放配置（level 读取自 config.js）
   ============================================================ */

// 音质等级合法值（ncm-api /song/url/v1 接口支持）
const PLAY_LEVELS = [
    'standard',   // 标准
    'higher',     // 较高
    'exhigh',     // 极高
    'lossless',   // 无损
    'hires',      // Hi-Res
    'jyeffect',   // 高清环绕声
    'sky',        // 沉浸环绕声
    'dolby',      // 杜比全景声
    'jymaster'    // 超清母带
];

// Toast 类型 → remixicon 图标名映射
const TOAST_ICONS = {
    success: 'checkbox-circle',
    error: 'error-warning',
    info: 'information'
};

// 默认播放配置：config.js 缺失或字段非法时的兜底值
const DEFAULT_PLAY_CONFIG = {
    level: 'exhigh'
};

class MusicPlayer {
    constructor() {
        this.initElements();
        this.initState();
        this.initEvents();
        this.renderPlayModeUI(); // 恢复持久化的播放模式 UI（图标/高亮）
        this.loadLastPlaylist();
    }
    
    initElements() {
        // 音频和控制元素
        this.audio = document.getElementById('audio');
        this.playBtn = document.getElementById('play-btn');
        this.prevBtn = document.getElementById('prev-btn');
        this.nextBtn = document.getElementById('next-btn');
        
        // 信息显示元素
        this.songName = document.getElementById('song-name');
        this.artistName = document.getElementById('artist-name');
        this.cover = document.getElementById('cover');
        this.songCount = document.querySelector('.song-count');
        
        // 进度条元素
        this.progress = document.querySelector('.progress');
        this.progressCurrent = document.querySelector('.progress-current');
        this.currentTime = document.getElementById('current-time');
        this.duration = document.getElementById('duration');
        
        // 播放列表元素
        this.playlist = document.getElementById('song-list');
        this.parseBtn = document.getElementById('parse-btn');
        this.playlistInput = document.getElementById('playlist-input');
        
        // 歌词元素
        this.lyricsContainer = document.getElementById('lyrics');
        
        // 播放模式控制元素
        this.modeBtn = document.getElementById('mode-btn');
        this.modeMenu = document.getElementById('mode-menu');
        
        // Toast容器
        this.toastContainer = document.querySelector('.toast-container');
    }
    
    initState() {
        this.songs = [];
        this.currentIndex = 0;
        this.isPlaying = false;
        this.currentLyric = null;
        this.lyrics = [];
        this.sourceToken = 0; // 切歌令牌：丢弃过期降级任务的异步结果，防止覆盖新歌
        this.failToken = null; // 失败提示去重：同一首歌只提示一次"播放失败"
        this._degrading = false; // 降级流程进行中：error 延迟验证不误报
        this._errorTimer = null; // error 延迟验证定时器
        this._playStarted = false; // 当前歌曲是否已真正开始播放（playing 事件）
        
        // 播放模式：sequential(顺序) / shuffle(随机) / loop(循环)，刷新后保留上次选择
        this.playMode = this.loadPlayMode();
        this.shuffleOrder = []; // 随机模式播放序列（无重复）
        this.shuffleCursor = 0; // 随机序列当前游标
        this.modeMenuOpen = false;
    }
    
    /**
     * 从 localStorage 读取持久化的播放模式，非法值回退为顺序播放
     */
    loadPlayMode() {
        const saved = localStorage.getItem('playMode');
        return ['sequential', 'shuffle', 'loop'].includes(saved) ? saved : 'sequential';
    }
    
    initEvents() {
        // 播放控制事件
        this.playBtn.addEventListener('click', () => this.togglePlay());
        this.prevBtn.addEventListener('click', () => this.prevSong());
        this.nextBtn.addEventListener('click', () => this.nextSong());
        
        // 进度条事件
        this.progress.addEventListener('click', (e) => this.setProgress(e));
        
        // 音频事件
        this.audio.addEventListener('timeupdate', () => this.updateProgress());
        this.audio.addEventListener('ended', () => this.nextSong(true));
        // 音频加载完成：结束封面加载态
        this.audio.addEventListener('loadeddata', () => this.cover.classList.remove('loading'));
        // 音频真正开始播放：同步 UI 状态（降级恢复播放后不再残留"播放失败"态）
        this.audio.addEventListener('playing', () => {
            this._degrading = false; // 音频真正开始播放：解除降级标记
            this._playStarted = true;
            this.isPlaying = true;
            this.playBtn.innerHTML = '<i class="ri-pause-fill"></i>';
            this.failToken = null; // 播放已恢复，允许后续失败重新提示
        });
        // 播放中出错（如网络中断）：延迟验证，仅在音频从未成功播放、不在降级流程、
        // 且无可用数据时才提示失败，避免降级缓冲期间误报
        this.audio.addEventListener('error', () => {
            clearTimeout(this._errorTimer);
            this._errorTimer = setTimeout(() => {
                if (this.isPlaying && this.audio.paused && !this._degrading &&
                    !this._playStarted && this.audio.readyState === 0) {
                    this.showPlayFail();
                }
            }, 800);
        });
        
        // 解析歌单事件
        this.parseBtn.addEventListener('click', () => this.parsePlaylist());
        this.playlistInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.parsePlaylist();
        });

        // 关闭提示事件
        const tipClose = document.querySelector('.tip-close');
        const welcomeTip = document.querySelector('.welcome-tip');
        if (tipClose && welcomeTip) {
            tipClose.addEventListener('click', () => {
                welcomeTip.classList.add('closing');
                setTimeout(() => welcomeTip.remove(), 300);
            });
        }
        
        // 播放模式切换事件
        this.modeBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止冒泡触发全局关闭，用于立即打开
            this.toggleModeMenu();
        });
        this.modeMenu.addEventListener('click', (e) => {
            const option = e.target.closest('.mode-option');
            if (!option) return;
            this.setPlayMode(option.dataset.mode);
        });
        // 点击页面其他区域关闭悬浮菜单
        document.addEventListener('click', () => this.closeModeMenu());
    }
    
    /* ---------- 播放模式控制 ---------- */
    
    /**
     * 模式图标映射：按钮图标与当前激活模式保持一致
     */
    MODE_ICONS = {
        sequential: 'ri-list-unordered',
        shuffle: 'ri-shuffle-line',
        loop: 'ri-repeat-line'
    };
    
    /**
     * 切换悬浮菜单显示/隐藏状态
     */
    toggleModeMenu() {
        if (this.modeMenuOpen) {
            this.closeModeMenu();
        } else {
            this.openModeMenu();
        }
    }
    
    openModeMenu() {
        this.modeMenuOpen = true;
        this.modeMenu.classList.add('open');
    }
    
    closeModeMenu() {
        this.modeMenuOpen = false;
        this.modeMenu.classList.remove('open');
    }
    
    /**
     * 设置播放模式：更新状态、持久化、同步 UI（按钮图标 + 菜单高亮）
     */
    setPlayMode(mode) {
        if (!['sequential', 'shuffle', 'loop'].includes(mode)) return;
        this.playMode = mode;
        localStorage.setItem('playMode', mode);
        this.closeModeMenu();
        this.renderPlayModeUI();
        // 切换为随机模式时重建无重复随机序列
        if (mode === 'shuffle') {
            this.buildShuffleOrder();
        }
    }
    
    /**
     * 同步模式相关 UI：按钮图标 + 悬浮菜单选项高亮
     */
    renderPlayModeUI() {
        this.modeBtn.innerHTML = `<i class="${this.MODE_ICONS[this.playMode]}"></i>`;
        this.modeMenu.querySelectorAll('.mode-option').forEach((opt) => {
            opt.classList.toggle('active', opt.dataset.mode === this.playMode);
        });
    }
    
    /**
     * 构建无重复随机播放序列（Fisher-Yates 洗牌）：
     * 序列包含全列表索引，且首元素为当前正在播放的曲目，
     * 保证整轮遍历中不重复、且切换后不会跳过当前曲目
     */
    buildShuffleOrder(startIndex = this.currentIndex) {
        const len = this.songs.length;
        if (!len) {
            this.shuffleOrder = [];
            this.shuffleCursor = 0;
            return;
        }
        // 当前曲目固定为首位，其余索引洗牌
        const rest = [];
        for (let i = 0; i < len; i++) {
            if (i !== startIndex) rest.push(i);
        }
        for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        this.shuffleOrder = [startIndex, ...rest];
        this.shuffleCursor = 0;
    }
    
    /**
     * 随机模式：取无重复序列中的下一首（游标前进，越界重新洗牌）
     * 重新洗牌时避免首元素与上一轮结尾连续重复
     */
    nextShuffleIndex() {
        if (!this.shuffleOrder.length) this.buildShuffleOrder();
        if (this.shuffleCursor >= this.shuffleOrder.length - 1) {
            const lastPlayed = this.shuffleOrder[this.shuffleOrder.length - 1];
            this.buildShuffleOrder();
            // 若新序列首位与上轮结尾相同，则交换消除连续重复
            if (this.shuffleOrder.length > 1 && this.shuffleOrder[0] === lastPlayed) {
                [this.shuffleOrder[0], this.shuffleOrder[1]] =
                    [this.shuffleOrder[1], this.shuffleOrder[0]];
            }
        } else {
            this.shuffleCursor++;
        }
        return this.shuffleOrder[this.shuffleCursor];
    }
    
    /**
     * 根据当前播放模式计算下一首索引；返回 -1 表示播放结束（顺序模式自动播完最后一首）
     * fromAuto=true 表示由音频自然播放结束触发（区分手动切歌）
     */
    getNextIndex(fromAuto = false) {
        if (this.playMode === 'sequential') {
            // 手动点击下一首：最后一首后循环回第一首；自动播完：末尾停止
            if (this.currentIndex >= this.songs.length - 1) {
                return fromAuto ? -1 : 0;
            }
            return this.currentIndex + 1;
        }
        if (this.playMode === 'shuffle') {
            return this.nextShuffleIndex();
        }
        // loop：循环回到第一首
        return (this.currentIndex + 1) % this.songs.length;
    }
    
    /**
     * 上面这些事件用到的关键方法：根据模式决定上一首（随机模式回退游标）
     */
    getPrevIndex() {
        if (this.playMode === 'shuffle') {
            if (!this.shuffleOrder.length) this.buildShuffleOrder();
            this.shuffleCursor = Math.max(0, this.shuffleCursor - 1);
            return this.shuffleOrder[this.shuffleCursor];
        }
        return (this.currentIndex - 1 + this.songs.length) % this.songs.length;
    }
    
    /**
     * HTML 转义，防止外部文本（歌单名/歌词/接口消息）破坏页面结构
     */
    escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[c]));
    }

    /**
     * 展示 Toast 提示：按类型映射图标，支持手动关闭，短时内相同文案自动去重
     */
    showToast(message, type = 'success') {
        // 去重：2.5s 内相同文案只弹一条，避免连点堆叠
        if (this._lastToastMsg === message &&
            this._lastToastTime && Date.now() - this._lastToastTime < 2500) {
            return;
        }
        this._lastToastMsg = message;
        this._lastToastTime = Date.now();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <i class="ri-${TOAST_ICONS[type] || 'error-warning'}-line"></i>
            <span>${this.escapeHtml(message)}</span>
            <button type="button" class="toast-close" aria-label="关闭提示">
                <i class="ri-close-line"></i>
            </button>
        `;

        // 手动关闭（带退出动画）
        toast.querySelector('.toast-close').addEventListener('click', () => {
            toast.classList.add('toast-hide');
            setTimeout(() => toast.remove(), 250);
        });

        this.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-hide');
            setTimeout(() => toast.remove(), 250);
        }, 3000);
    }
    
    loadLastPlaylist() {
        const lastPlaylistId = localStorage.getItem('lastPlaylistId');
        if (lastPlaylistId) {
            this.playlistInput.value = lastPlaylistId;
            this.parsePlaylist();
        }
    }
    
    async parsePlaylist() {
        const playlistId = this.playlistInput.value.trim();
        if (!playlistId) {
            this.showToast('请输入歌单ID', 'error');
            return;
        }
        
        try {
            this.parseBtn.disabled = true;
            this.parseBtn.textContent = '解析中...';
            
            const response = await fetch(`https://api.qijieya.cn/meting/?type=playlist&id=${playlistId}`);
            if (!response.ok) throw { friendly: '网络异常，请稍后重试' };
            const data = await response.json();
            
            if (!Array.isArray(data) || data.length === 0) {
                throw { friendly: '无效的歌单ID或歌单为空' };
            }
            
            this.songs = data;
            this.currentIndex = 0;
            this.renderPlaylist();
            await this.loadSong();
            
            // 解析成功后再持久化，避免坏 ID 每次刷新都自动重试
            localStorage.setItem('lastPlaylistId', playlistId);
            this.showToast(`成功加载 ${data.length} 首歌曲`);
            this.songCount.textContent = `${data.length} 首歌曲`;
            
        } catch (error) {
            this.showToast(error.friendly || '解析失败，请检查网络或歌单ID后重试', 'error');
            console.error('Error parsing playlist:', error);
        } finally {
            this.parseBtn.disabled = false;
            this.parseBtn.textContent = '解析';
        }
    }
    
    /**
     * 从歌单浏览弹窗加载歌单：替换当前列表、更新输入框与持久化，并开始播放
     */
    async loadPlaylist(songs, playlistId) {
        this.songs = songs;
        this.currentIndex = 0;
        this.renderPlaylist();
        this.songCount.textContent = `${songs.length} 首歌曲`;
        if (playlistId) {
            this.playlistInput.value = playlistId;
            localStorage.setItem('lastPlaylistId', playlistId);
        }
        await this.playSong(0);
        this.showToast(`成功加载 ${songs.length} 首歌曲`);
    }

    renderPlaylist() {
        // 全量渲染播放列表（歌单加载/切换时调用）；标题/歌手需转义，防外部注入
        this.playlist.innerHTML = this.songs.map((song, index) => `
            <li class="${index === this.currentIndex ? 'active' : ''}" 
                onclick="player.playSong(${index})">
                <div class="song-index">${(index + 1).toString().padStart(2, '0')}</div>
                <div class="song-details">
                    <div class="song-name">${this.escapeHtml(song.title || song.name)}</div>
                    <div class="song-artist">${this.escapeHtml(song.author || song.artist)}</div>
                </div>
            </li>
        `).join('');
    }
    
    /**
     * 同步播放列表高亮到当前播放歌曲，并自动滚动定位（顺序/随机/循环模式均生效）
     */
    syncPlaylistActive() {
        const items = this.playlist.children;
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('active', i === this.currentIndex);
        }
        // 直接滚动 .playlist 容器到当前歌曲位置（scrollIntoView 在嵌套滚动场景不可靠）
        const scrollContainer = this.playlist.closest('.playlist') || this.playlist;
        const activeItem = this.playlist.querySelector('li.active');
        if (activeItem && scrollContainer.scrollHeight > scrollContainer.clientHeight) {
            const containerTop = scrollContainer.getBoundingClientRect().top;
            const itemTop = activeItem.getBoundingClientRect().top;
            const itemHeight = activeItem.offsetHeight;
            const targetScroll = scrollContainer.scrollTop +
                (itemTop - containerTop) - (scrollContainer.clientHeight - itemHeight) / 2;
            scrollContainer.scrollTo({
                top: Math.max(0, targetScroll),
                behavior: 'smooth'
            });
        }
    }
    
    async loadSong() {
        if (!this.songs.length) return;
        
        const song = this.songs[this.currentIndex];
        this.sourceToken++; // 递增切歌令牌，使旧降级任务的结果失效
        const token = this.sourceToken;
        this._playStarted = false; // 新歌尚未真正开始播放
        
        this.songName.textContent = song.title || song.name;
        this.artistName.textContent = song.author || song.artist;
        // 封面兜底：加载失败显示内置占位图，避免破图
        this.cover.src = song.pic || '';
        this.cover.onerror = () => {
            this.cover.onerror = null;
            this.cover.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="%23eef1f8"/><text x="50%" y="50%" fill="%234f6ef7" font-size="72" text-anchor="middle" dominant-baseline="middle">♪</text></svg>';
        };
        this.cover.classList.add('loading'); // 切歌加载反馈，音频加载完成或降级结束后移除
        
        // 同步设置主接口播放链接，保证点击播放即时响应；
        // 随后后台静默降级探测：主接口无效时自动切换备用接口，不阻塞用户操作
        // （http 统一转 https，避免 https 页面混合内容被浏览器拦截）
        this.audio.src = (song.url || '').replace(/^http:\/\//i, 'https://');
        this.runSourceFallback(song, token);
        
        // 同步播放列表高亮并滚动定位到当前播放歌曲
        this.syncPlaylistActive();
        
        // 加载歌词（8s 超时，接口挂起时不阻塞切歌）
        const lrcController = new AbortController();
        const lrcTimer = setTimeout(() => lrcController.abort(), 8000);
        try {
            const response = await fetch(song.lrc, { signal: lrcController.signal });
            const lrcText = await response.text();
            if (token === this.sourceToken) {
                this.parseLyric(lrcText);
            }
        } catch (error) {
            console.error('Error loading lyrics:', error);
            if (token === this.sourceToken) {
                this.lyricsContainer.innerHTML = '<p class="empty-lyrics">暂无歌词</p>';
            }
        } finally {
            clearTimeout(lrcTimer);
        }
        
        if (this.isPlaying) {
            // 主接口播放失败不立即提示：交由后台降级流程处理（有可用备用链接则静默续播，双失败才提示）
            this.audio.play().catch(() => this.fallbackAndPlay(token));
        }
    }
    
    /**
     * 获取可播放的播放链接（主接口优先，失败则静默降级备用接口）：
     * - 返回可用链接；主、备用接口均失败时返回空字符串
     */
    async ensurePlayUrl(song) {
        // 1) 主播放接口（http 统一转 https，避免 https 页面混合内容被拦截）
        const mainUrl = (song.url || '').replace(/^http:\/\//i, 'https://');
        const songId = this.extractSongId(song);
        
        if (mainUrl && await this.probePlayable(mainUrl)) {
            return mainUrl; // 主接口正常：仅调用主接口
        }
        
        // 2) 备用播放接口：传入相同音乐 ID，接口切换过程静默、不提示用户
        if (songId) {
            const backupUrl = await this.fetchBackupPlayUrl(songId);
            if (backupUrl && await this.probePlayable(backupUrl)) {
                return backupUrl;
            }
        }
        
        // 3) 主、备用接口均失败
        return '';
    }
    
    /**
     * 后台降级探测：主接口链接无效时，静默将 audio.src 替换为备用接口链接
     * （双失败且正在播放时才提示，其余场景等待用户操作）
     */
    async runSourceFallback(song, token) {
        const playUrl = await this.ensurePlayUrl(song);
        if (token !== this.sourceToken) return; // 已切歌，丢弃过期结果
        this.cover.classList.remove('loading'); // 降级探测结束，结束封面加载态
        if (!playUrl) {
            // 主、备用接口均探测失败：若音频实际已在播放（探测误判），静默保留当前播放
            if (this.isPlaying && !this.audio.paused && this.audio.readyState >= 2) {
                return;
            }
            // 仅当正在播放时才提示
            if (this.isPlaying) this.showPlayFail();
            return;
        }
        if (playUrl !== this.audio.getAttribute('src')) {
            this.audio.src = playUrl;
            // 替换 src 会中断当前播放，若处于播放态则恢复播放
            if (this.isPlaying) {
                this.audio.play().catch(() => {});
            }
        }
    }
    
    /**
     * 从歌曲对象中提取音乐 ID：
     * 依次从 url / lrc / pic 链接的 id 参数中提取，任一含 id 即返回
     */
    extractSongId(song) {
        if (!song) return '';
        const pick = (u) => {
            const m = String(u || '').match(/[?&]id=(\d+)/);
            return m ? m[1] : '';
        };
        return pick(song.url) || pick(song.lrc) || pick(song.pic);
    }
    
    /**
     * 探测链接是否为可播放的有效音频（通过 audio 元素加载，不受 CORS 限制）
     */
    probePlayable(url, timeout = 8000) {
        return new Promise((resolve) => {
            if (!url) {
                resolve(false);
                return;
            }
            const probe = new Audio();
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                probe.removeEventListener('loadedmetadata', onOk);
                probe.removeEventListener('error', onErr);
                probe.removeAttribute('src');
                probe.load();
                resolve(ok);
            };
            const onOk = () => finish(true);
            const onErr = () => finish(false);
            const timer = setTimeout(() => finish(false), timeout);
            probe.addEventListener('loadedmetadata', onOk);
            probe.addEventListener('error', onErr);
            probe.preload = 'metadata';
            probe.src = url;
        });
    }
    
    /**
     * 备用播放接口（多源依次尝试，传入相同音乐 ID 获取播放链接）：
     * 1) ncm-api 播放链接接口（unblock=true，无需 Cookie）
     * 2) meting type=song 接口（与示例网页接口规范一致）
     */
    async fetchBackupPlayUrl(songId) {
        if (!songId) return '';
        // 1) ncm-api 鉴权直链接口
        try {
            const authUrl = await this.fetchNcmApiPlayUrl(songId);
            if (authUrl) return authUrl;
        } catch (error) {
            console.error('ncm-api 备用接口请求失败:', error);
        }
        // 2) meting type=song 备用接口
        try {
            const response = await fetch(
                `https://api.qijieya.cn/meting/?server=netease&type=song&id=${songId}`
            );
            const data = await response.json();
            if (!Array.isArray(data) || !data.length) return '';
            return data[0].url || '';
        } catch (error) {
            console.error('备用播放接口请求失败:', error);
            return '';
        }
    }
    
    /**
     * 读取当前播放配置（音质等级）：
     * - 优先取 config.js 中的 window.NCM_CONFIG
     * - level 非法时回退默认值，config.js 缺失也能正常运行
     */
    getPlayConfig() {
        const cfg = (typeof window !== 'undefined' && window.NCM_CONFIG) || {};
        return {
            level: PLAY_LEVELS.includes(cfg.level) ? cfg.level : DEFAULT_PLAY_CONFIG.level
        };
    }

    /**
     * ncm-api 播放链接接口：
     * - 携带音质等级与 unblock=true 即可返回播放链接，无需 Cookie
     *   （格式：/song/url/v1?id=xxx&level=xxx&unblock=true）
     * - 等级在 config.js 中配置，修改后刷新页面即生效
     * - 返回的链接可能为 http，统一转为 https 以保证浏览器可播
     */
    async fetchNcmApiPlayUrl(songId) {
        if (!songId) return '';
        const { level } = this.getPlayConfig();
        const params = new URLSearchParams({ id: songId, level, unblock: 'true' });
        const response = await fetch(
            `https://ncm-api.prod.gbclstudio.cn/song/url/v1?${params.toString()}`
        );
        if (!response.ok) return '';
        const data = await response.json();
        const url = data && data.data && data.data[0] ? data.data[0].url : '';
        if (!url) return '';
        // http → https
        return url.replace(/^http:\/\//i, 'https://');
    }
    
    parseLyric(lrcText) {
        const lines = lrcText.split('\n');
        const lyrics = [];
        
        lines.forEach(line => {
            // 兼容 [mm:ss.xx] / [mm:ss:xx] / [mm:ss] 三种时间戳格式
            const match = line.match(/\[(\d{2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)/);
            if (match) {
                const frac = match[3] ? Math.pow(10, match[3].length) : 1000;
                const time = parseInt(match[1], 10) * 60 + parseInt(match[2], 10) +
                    parseInt(match[3] || '0', 10) / frac;
                const text = match[4].trim();
                if (text) {
                    lyrics.push({ time, text });
                }
            }
        });
        
        this.lyrics = lyrics;
        this.renderLyrics();
    }
    
    renderLyrics() {
        if (!this.lyrics.length) {
            this.lyricsContainer.innerHTML = '<p class="empty-lyrics">暂无歌词</p>';
            return;
        }
        
        this.lyricsContainer.innerHTML = this.lyrics
            .map(lyric => `<p class="lyrics-line" data-time="${lyric.time}">${this.escapeHtml(lyric.text)}</p>`)
            .join('');
    }
    
    updateLyrics(currentTime) {
        if (!this.lyrics.length) return;
        
        const currentLyric = this.lyrics.find((lyric, index) => {
            const nextLyric = this.lyrics[index + 1];
            return currentTime >= lyric.time && (!nextLyric || currentTime < nextLyric.time);
        });
        
        if (currentLyric && this.currentLyric !== currentLyric) {
            this.currentLyric = currentLyric;
            const allLines = this.lyricsContainer.querySelectorAll('.lyrics-line');
            allLines.forEach(line => line.classList.remove('active'));
            
            const activeLine = this.lyricsContainer.querySelector(`[data-time="${currentLyric.time}"]`);
            if (activeLine) {
                activeLine.classList.add('active');
                activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }
    
    togglePlay() {
        if (this.isPlaying) {
            this.audio.pause();
            this.playBtn.innerHTML = '<i class="ri-play-fill"></i>';
            this.isPlaying = false;
        } else {
            this.playBtn.innerHTML = '<i class="ri-pause-fill"></i>';
            this.isPlaying = true;
            // 若主接口链接无效，play() 会失败，此时静默降级备用接口再试
            this.audio.play().catch(() => this.fallbackAndPlay(this.sourceToken));
        }
    }
    
    /**
     * 统一的播放失败处理：重置状态并向用户提示"播放失败"（按歌去重，避免重复提示）
     */
    showPlayFail() {
        if (this.failToken === this.sourceToken) return;
        this.failToken = this.sourceToken;
        this.audio.pause();
        this.playBtn.innerHTML = '<i class="ri-play-fill"></i>';
        this.isPlaying = false;
        this.showToast('播放失败，请重试', 'error');
    }
    
    /**
     * 主接口播放失败时的静默降级：尝试用备用接口链接重新播放；
     * token 校验防止切歌后旧降级结果覆盖新歌
     */
    async fallbackAndPlay(token) {
        const song = this.songs[this.currentIndex];
        if (!song) {
            this.showPlayFail();
            return;
        }
        this._degrading = true; // 降级期间屏蔽 error 误报；由 playing 事件或失败路径解除
        try {
            const playUrl = await this.ensurePlayUrl(song);
            if (token !== this.sourceToken) {
                this._degrading = false; // 已切歌，丢弃过期结果并解除降级标记
                return;
            }
            this.cover.classList.remove('loading');
            if (!playUrl) {
                // 主、备用接口均失败：统一提示（按歌去重）
                this._degrading = false;
                this.showPlayFail();
                return;
            }
            this.audio.src = playUrl;
            this.audio.play().catch(() => {
                this._degrading = false;
                this.showPlayFail();
            });
            // 注意：play() 成功后不立即解除 _degrading，等 playing 事件（音频真正开始播放）
            // 再解除，避免备用 URL 缓冲期间 error 定时器误报"播放失败"
        } catch (error) {
            this._degrading = false;
        }
    }
    
    async playSong(index) {
        this.currentIndex = index;
        // 手动选歌：随机模式下游标定位到所选曲目，保持"无重复"逻辑连续
        if (this.playMode === 'shuffle') {
            this.buildShuffleOrder();
        }
        await this.loadSong();
        if (!this.isPlaying) {
            this.togglePlay();
        }
    }
    
    async prevSong() {
        if (!this.songs.length) return;
        this.currentIndex = this.getPrevIndex();
        await this.loadSong();
        // 手动切歌：暂停状态下也自动开始播放
        if (!this.isPlaying) this.togglePlay();
    }
    
    async nextSong(fromAuto = false) {
        if (!this.songs.length) return;
        const nextIndex = this.getNextIndex(fromAuto);
        if (nextIndex === -1) {
            // 顺序模式自动播放到最后一首：停止播放
            this.audio.pause();
            this.audio.currentTime = 0;
            this.playBtn.innerHTML = '<i class="ri-play-fill"></i>';
            this.isPlaying = false;
            return;
        }
        this.currentIndex = nextIndex;
        await this.loadSong();
        // 手动切歌：暂停状态下也自动开始播放
        if (!this.isPlaying) this.togglePlay();
    }
    
    updateProgress() {
        const { currentTime, duration } = this.audio;
        // 时长无效（未加载/降级切换中）时跳过进度更新，避免 NaN 渲染
        if (!duration || !isFinite(duration)) {
            this.duration.textContent = this.formatTime(0);
            return;
        }
        const progressPercent = Math.min((currentTime / duration) * 100, 100);
        this.progressCurrent.style.width = `${progressPercent}%`;
        
        this.currentTime.textContent = this.formatTime(currentTime);
        this.duration.textContent = this.formatTime(duration);
        
        this.updateLyrics(currentTime);
    }
    
    setProgress(e) {
        const width = this.progress.clientWidth;
        const duration = this.audio.duration;
        // 未加载（duration 无效）时忽略点击，避免写入 NaN
        if (!width || !isFinite(duration) || duration <= 0) return;
        const ratio = Math.min(Math.max(e.offsetX / width, 0), 1);
        this.audio.currentTime = ratio * duration;
    }
    
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

/* ============================================================
   歌单浏览弹窗（ncm-api 接口）
   ============================================================ */
class PlaylistBrowser {
    constructor(player) {
        this.player = player;
        this.API_BASE = 'https://ncm-api.prod.gbclstudio.cn';
        this.PAGE_SIZE = 50;
        this.CACHE_KEY = 'playlistCategoriesCache'; // 分类本地缓存（1 天有效）
        this.LIST_CACHE_KEY = 'playlistListCache'; // 歌单列表本地缓存（5 分钟有效）

        this.elements = {
            openBtn: document.getElementById('playlist-btn'),
            overlay: document.getElementById('playlist-modal'),
            closeBtn: document.getElementById('modal-close'),
            tabs: document.getElementById('modal-tabs'),
            cats: document.getElementById('modal-cats'),
            playlists: document.getElementById('modal-playlists'),
            loadMoreBtn: document.getElementById('load-more-btn'),
            footer: document.getElementById('modal-footer')
        };

        // 两种模式的差异配置：分类接口、歌单接口、分页参数构建与推进
        this.specs = {
            normal: {
                label: '普通歌单',
                catsApi: '/playlist/catlist',
                catsData: (data) => {
                    const sub = (data && data.sub) || [];
                    return [{ name: '全部' }, ...sub.map((s) => ({ name: s.name }))];
                },
                listApi: '/top/playlist',
                buildParams: (ms) => {
                    const params = new URLSearchParams({
                        order: 'hot',
                        limit: String(this.PAGE_SIZE),
                        offset: String(ms.offset)
                    });
                    return params;
                },
                isFirstPage: (ms) => ms.offset === 0,
                applyPage: (ms, data, playlists) => {
                    ms.offset += playlists.length;
                    ms.hasMore = (data && data.more) || playlists.length >= this.PAGE_SIZE;
                }
            },
            highquality: {
                label: '精品歌单',
                catsApi: '/playlist/highquality/tags',
                catsData: (data) => {
                    const tags = (data && data.tags) || [];
                    return [{ name: '全部' }, ...tags.map((t) => ({ name: t.name }))];
                },
                listApi: '/top/playlist/highquality',
                buildParams: (ms) => {
                    const params = new URLSearchParams({ limit: String(this.PAGE_SIZE) });
                    if (ms.before) params.set('before', String(ms.before));
                    return params;
                },
                isFirstPage: (ms) => ms.before === 0,
                applyPage: (ms, data, playlists) => {
                    const last = playlists[playlists.length - 1];
                    ms.before = last ? last.updateTime : 0;
                    ms.hasMore = (data && data.more) || playlists.length >= this.PAGE_SIZE;
                }
            }
        };

        // 每种模式独立的分类与分页状态
        this.modes = {
            normal: this.createModeState(),
            highquality: this.createModeState()
        };
        this.state = { open: false, mode: 'normal' };

        this.initEvents();
    }

    createModeState() {
        return {
            cats: [{ name: '全部' }],
            catsLoaded: false,
            currentCat: '全部',
            playlistsLoaded: false,
            offset: 0,
            before: 0,
            hasMore: true,
            loading: false,
            gridHTML: '', // 歌单卡片渲染缓存，切换板块时恢复
            loadMoreText: '加载更多',
            loadMoreDisabled: false,
            prefetched: null, // 滚动到底部时预取的下一页数据
            prefetching: false,
            prefetchedFirstPage: null, // 后台预取的该模式第一页数据（切换板块时秒开）
            prefetchingFirstPage: false
        };
    }

    getSpec() {
        return this.specs[this.state.mode];
    }

    getModeState() {
        return this.modes[this.state.mode];
    }

    /**
     * 请求 ncm-api 并解析 JSON（自动重试 + 超时 + 响应校验）：
     * - 接口偶发"HTTP 200 但内容为错误页"、连接失败或超时，自动重试若干次降低失败概率
     * - 业务错误码（code 非 200）为明确响应，不重试
     */
    async fetchJson(url, { retries = 3, retryDelay = 500, timeoutMs = 8000 } = {}) {
        let lastError;
        for (let attempt = 0; attempt < retries; attempt++) {
            if (attempt > 0) {
                // 退避等待：第 2 次等 0.5s，第 3 次等 1s
                await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(url, { signal: controller.signal });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                let data;
                try {
                    data = await response.json();
                } catch (error) {
                    throw new Error('响应格式错误（非 JSON）');
                }
                if (data && typeof data.code === 'number' && data.code !== 200) {
                    throw new Error(data.message || `接口错误 code=${data.code}`);
                }
                return data;
            } catch (error) {
                lastError = error;
                if (error.message && error.message.indexOf('接口错误') === 0) {
                    break; // 业务错误码是明确响应，重试无意义
                }
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastError;
    }

    initEvents() {
        // 打开 / 关闭
        this.elements.openBtn.addEventListener('click', () => this.open());
        this.elements.closeBtn.addEventListener('click', () => this.close());
        // 点击遮罩空白处关闭
        this.elements.overlay.addEventListener('click', (e) => {
            if (e.target === this.elements.overlay) this.close();
        });
        // Esc 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.state.open) this.close();
        });

        // 普通歌单 / 精品歌单 切换
        this.elements.tabs.addEventListener('click', (e) => {
            const tab = e.target.closest('.modal-tab');
            if (tab) this.switchMode(tab.dataset.mode);
        });

        // 分类切换（含分类加载失败重试）
        this.elements.cats.addEventListener('click', (e) => {
            if (e.target.closest('[data-retry-cats]')) {
                this.loadCategories();
                return;
            }
            const chip = e.target.closest('.cat-chip');
            if (chip) this.selectCat(chip.dataset.cat);
        });

        // 歌单卡片：点击 ID 复制 / 点击卡片加载 / 列表加载失败重试
        this.elements.playlists.addEventListener('click', (e) => {
            if (e.target.closest('[data-retry-list]')) {
                this.loadPlaylists();
                return;
            }
            const idEl = e.target.closest('.pl-id');
            if (idEl) {
                e.stopPropagation();
                this.copyId(idEl.dataset.id);
                return;
            }
            const card = e.target.closest('.pl-card');
            if (card) this.selectPlaylist(card.dataset.id);
        });

        // 加载更多
        this.elements.loadMoreBtn.addEventListener('click', () => this.loadMore());
        // 滚动到歌单列表底部时显示"加载更多"（rAF 节流，避免滚动卡顿），并预取下一页
        this.elements.playlists.addEventListener('scroll', () => {
            if (this._loadMoreBarRaf) return;
            this._loadMoreBarRaf = requestAnimationFrame(() => {
                this._loadMoreBarRaf = null;
                this.updateLoadMoreBar();
                this.prefetchNextPage();
            });
        });
    }

    /**
     * 根据歌单列表滚动位置控制"加载更多"按钮显隐：
     * 列表无需滚动或已滚动到底部时显示，否则隐藏
     */
    updateLoadMoreBar() {
        const el = this.elements.playlists;
        // 强制同步布局，确保 scrollHeight 反映刚渲染的最新内容
        void el.offsetHeight;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        const show = el.scrollHeight <= el.clientHeight || nearBottom;
        this.elements.footer.classList.toggle('visible', show);
    }

    async open() {
        if (this.state.open) return;
        this.state.open = true;
        this.elements.overlay.classList.add('open');
        document.body.style.overflow = 'hidden'; // 锁定背景滚动（移动端）
        const ms = this.getModeState();
        // 首次打开：并行加载分类与默认歌单，减少等待时间
        const tasks = [];
        if (!ms.catsLoaded) {
            tasks.push(this.loadCategories());
        }
        if (!ms.playlistsLoaded) {
            ms.offset = 0;
            ms.before = 0;
            ms.hasMore = true;
            ms.gridHTML = '';
            this.elements.playlists.innerHTML = '';
            tasks.push(this.loadPlaylists());
        } else {
            this.elements.playlists.innerHTML = ms.gridHTML;
            this.elements.loadMoreBtn.textContent = ms.loadMoreText;
            this.elements.loadMoreBtn.disabled = ms.loadMoreDisabled;
            this.updateLoadMoreBar();
        }
        await Promise.all(tasks);
        // 后台预加载另一个板块的第一页，切换时秒开
        this.prefetchOtherMode();
    }

    close() {
        this.state.open = false;
        this.elements.overlay.classList.remove('open');
        document.body.style.overflow = ''; // 恢复背景滚动
    }

    /**
     * 后台预取另一个板块（普通/精品互备）的第一页歌单，
     * 切换板块时直接使用，无需等待网络
     */
    prefetchOtherMode() {
        const otherMode = this.state.mode === 'normal' ? 'highquality' : 'normal';
        const ms = this.modes[otherMode];
        const spec = this.specs[otherMode];
        if (ms.playlistsLoaded || ms.prefetchingFirstPage) return;
        ms.prefetchingFirstPage = true;
        const firstPageMs = { ...ms, offset: 0, before: 0 };
        this.fetchJson(`${this.API_BASE}${spec.listApi}?${this.buildParams(spec, firstPageMs)}`)
            .then((data) => {
                if (!ms.playlistsLoaded) {
                    ms.prefetchedFirstPage = data;
                }
            })
            .catch(() => { /* 预取失败静默，切换时正常加载 */ })
            .finally(() => {
                ms.prefetchingFirstPage = false;
            });
    }

    /** 切换普通歌单 / 精品歌单模式 */
    async switchMode(mode) {
        if (mode === this.state.mode) return;
        this.state.mode = mode;
        this.renderTabs();
        this.renderCats(); // 立即刷新为当前模式的分类标签
        this.elements.playlists.scrollTop = 0;
        const ms = this.getModeState();
        // 并行加载分类与歌单，减少切换等待时间
        const tasks = [];
        if (!ms.catsLoaded) {
            tasks.push(this.loadCategories());
        }
        if (!ms.playlistsLoaded) {
            ms.offset = 0;
            ms.before = 0;
            ms.hasMore = true;
            ms.gridHTML = '';
            this.elements.playlists.innerHTML = '';
            if (ms.prefetchedFirstPage) {
                // 使用后台预取的第一页，立即渲染
                const data = ms.prefetchedFirstPage;
                ms.prefetchedFirstPage = null;
                this.applyPageData(data);
                this.updateLoadMoreBar();
            } else {
                tasks.push(this.loadPlaylists());
            }
        } else {
            // 恢复该模式缓存的歌单列表与加载更多状态
            this.elements.playlists.innerHTML = ms.gridHTML;
            this.elements.loadMoreBtn.textContent = ms.loadMoreText;
            this.elements.loadMoreBtn.disabled = ms.loadMoreDisabled;
            this.updateLoadMoreBar();
        }
        await Promise.all(tasks);
    }

    renderTabs() {
        this.elements.tabs.querySelectorAll('.modal-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.mode === this.state.mode);
        });
    }

    /** 加载当前模式的分类标签（普通: /playlist/catlist，精品: /playlist/highquality/tags） */
    async loadCategories() {
        const spec = this.getSpec();
        const ms = this.getModeState();
        // 优先使用本地缓存（1 天内有效），秒开分类栏，随后后台刷新
        const cached = this.getCachedCats(this.state.mode);
        if (cached) {
            ms.cats = cached;
            ms.catsLoaded = true;
            this.renderCats();
            this.fetchCategories(spec, ms);
            return;
        }
        this.elements.cats.innerHTML = '<button type="button" class="cat-chip" disabled>分类加载中...</button>';
        try {
            const data = await this.fetchJson(`${this.API_BASE}${spec.catsApi}`);
            ms.cats = spec.catsData(data);
            ms.catsLoaded = true;
            this.setCachedCats(this.state.mode, ms.cats);
            this.renderCats();
        } catch (error) {
            console.error('加载歌单分类失败:', error.message);
            this.elements.cats.innerHTML =
                '<button type="button" class="cat-chip" data-retry-cats="1">分类加载失败，点击重试</button>';
        }
    }

    /** 后台刷新分类缓存（失败静默，沿用本地缓存） */
    async fetchCategories(spec, ms) {
        try {
            const data = await this.fetchJson(`${this.API_BASE}${spec.catsApi}`);
            ms.cats = spec.catsData(data);
            ms.catsLoaded = true;
            this.setCachedCats(this.state.mode, ms.cats);
            this.renderCats();
        } catch (error) {
            console.error('后台刷新分类缓存失败:', error.message);
        }
    }

    /** 读取本地分类缓存（1 天内有效） */
    getCachedCats(mode) {
        try {
            const raw = localStorage.getItem(this.CACHE_KEY);
            if (!raw) return null;
            const cache = JSON.parse(raw);
            const entry = cache[mode];
            if (!entry || !entry.t || !entry.cats || !entry.cats.length) return null;
            if (Date.now() - entry.t > 86400000) return null;
            return entry.cats;
        } catch (error) {
            return null;
        }
    }

    /** 写入本地分类缓存 */
    setCachedCats(mode, cats) {
        try {
            const raw = localStorage.getItem(this.CACHE_KEY);
            const cache = raw ? JSON.parse(raw) : {};
            cache[mode] = { t: Date.now(), cats };
            localStorage.setItem(this.CACHE_KEY, JSON.stringify(cache));
        } catch (error) {
            // 忽略缓存写入失败
        }
    }

    renderCats() {
        const ms = this.getModeState();
        this.elements.cats.innerHTML = ms.cats.map((cat) => `
            <button type="button" class="cat-chip ${cat.name === ms.currentCat ? 'active' : ''}"
                    data-cat="${this.escapeHtml(cat.name)}">${this.escapeHtml(cat.name)}</button>
        `).join('');
    }

    async selectCat(cat) {
        const ms = this.getModeState();
        if (cat === ms.currentCat) return;
        ms.currentCat = cat;
        ms.playlistsLoaded = false;
        ms.offset = 0;
        ms.before = 0;
        ms.hasMore = true;
        ms.loading = false;
        ms.prefetched = null;
        ms.prefetchedFirstPage = null;
        this.renderCats();
        this.elements.playlists.innerHTML = '';
        this.elements.playlists.scrollTop = 0;
        await this.loadPlaylists();
    }

    /** 加载当前模式/分类的歌单，分页追加（普通: offset，精品: before） */
    async loadPlaylists() {
        const spec = this.getSpec();
        const ms = this.getModeState();
        if (ms.loading) return;

        // 首页优先使用本地缓存（5 分钟内），秒开列表，随后后台刷新
        if (spec.isFirstPage(ms)) {
            const cacheKey = `${this.state.mode}:${ms.currentCat}`;
            const cached = this.getCachedList(cacheKey);
            if (cached) {
                this.applyPageData(cached);
                this.updateLoadMoreBar();
                this.refreshListCache(cacheKey);
                return;
            }
        }

        ms.loading = true;
        this.elements.loadMoreBtn.disabled = true;
        this.elements.loadMoreBtn.textContent = '加载中...';
        this.elements.playlists.classList.add('loading');

        try {
            const data = await this.fetchJson(`${this.API_BASE}${spec.listApi}?${this.buildParams(spec, ms)}`);
            if (spec.isFirstPage(ms)) {
                this.setCachedList(`${this.state.mode}:${ms.currentCat}`, data);
            }
            this.applyPageData(data);
        } catch (error) {
            console.error('加载歌单失败:', error.message);
            this.player.showToast('歌单加载失败，请重试', 'error');
            // 恢复加载更多按钮，避免卡在"加载中..."，可直接重试
            this.elements.loadMoreBtn.textContent = ms.hasMore ? '加载更多' : '没有更多了';
            this.elements.loadMoreBtn.disabled = !ms.hasMore;
            ms.loadMoreText = this.elements.loadMoreBtn.textContent;
            ms.loadMoreDisabled = this.elements.loadMoreBtn.disabled;
            // 首次加载失败且列表为空时，显示重试入口
            if (!this.elements.playlists.children.length) {
                this.elements.playlists.innerHTML = `
                    <div class="pl-empty">
                        <button type="button" class="retry-btn" data-retry-list="1">加载失败，点击重试</button>
                    </div>`;
                ms.gridHTML = this.elements.playlists.innerHTML;
            }
        } finally {
            ms.loading = false;
            this.elements.playlists.classList.remove('loading');
            this.updateLoadMoreBar();
        }
    }

    /** 读取本地歌单列表缓存（5 分钟内有效） */
    getCachedList(key) {
        try {
            const raw = localStorage.getItem(this.LIST_CACHE_KEY);
            if (!raw) return null;
            const cache = JSON.parse(raw);
            const entry = cache[key];
            if (!entry || !entry.t || !entry.data) return null;
            if (Date.now() - entry.t > 300000) return null;
            return entry.data;
        } catch (error) {
            return null;
        }
    }

    /** 写入本地歌单列表缓存 */
    setCachedList(key, data) {
        try {
            const raw = localStorage.getItem(this.LIST_CACHE_KEY);
            const cache = raw ? JSON.parse(raw) : {};
            cache[key] = { t: Date.now(), data };
            localStorage.setItem(this.LIST_CACHE_KEY, JSON.stringify(cache));
        } catch (error) {
            // 忽略缓存写入失败
        }
    }

    /** 后台刷新列表缓存（仅更新缓存，不打断当前浏览） */
    async refreshListCache(cacheKey) {
        const [mode, cat] = cacheKey.split(':');
        const spec = this.specs[mode];
        const ms = this.modes[mode];
        try {
            const firstPageMs = { ...ms, offset: 0, before: 0, currentCat: cat };
            const data = await this.fetchJson(`${this.API_BASE}${spec.listApi}?${this.buildParams(spec, firstPageMs)}`);
            this.setCachedList(cacheKey, data);
        } catch (error) {
            console.error('后台刷新歌单缓存失败:', error.message);
        }
    }

    /** 构建当前模式的请求参数（含分类） */
    buildParams(spec, ms) {
        const params = spec.buildParams(ms);
        if (ms.currentCat !== '全部') {
            params.set('cat', ms.currentCat);
        }
        return params;
    }

    /** 构建下一页请求参数（用于预取） */
    buildNextParams(spec, ms) {
        const next = { ...ms, offset: ms.offset + this.PAGE_SIZE };
        return this.buildParams(spec, next);
    }

    /** 应用一页歌单数据：渲染、推进分页、更新按钮状态、清除预取 */
    applyPageData(data) {
        const spec = this.getSpec();
        const ms = this.getModeState();
        const playlists = (data && data.playlists) || [];
        const isFirstPage = spec.isFirstPage(ms);
        if (isFirstPage) {
            this.elements.playlists.innerHTML = '';
        }
        this.renderPlaylists(playlists, isFirstPage);
        spec.applyPage(ms, data, playlists);
        ms.playlistsLoaded = true;
        ms.prefetched = null;

        this.elements.loadMoreBtn.textContent = ms.hasMore ? '加载更多' : '没有更多了';
        this.elements.loadMoreBtn.disabled = !ms.hasMore;
        ms.loadMoreText = this.elements.loadMoreBtn.textContent;
        ms.loadMoreDisabled = this.elements.loadMoreBtn.disabled;
    }

    /**
     * 滚动到底部时后台预取下一页歌单，点击"加载更多"时立即显示。
     * 预取带分类/分页标记，切换分类后自动丢弃过期结果
     */
    prefetchNextPage() {
        const spec = this.getSpec();
        const ms = this.getModeState();
        if (ms.loading || ms.prefetching || ms.prefetched || !ms.hasMore) return;
        const tag = { cat: ms.currentCat, offset: ms.offset, before: ms.before };
        ms.prefetching = true;
        this.fetchJson(`${this.API_BASE}${spec.listApi}?${this.buildNextParams(spec, ms)}`)
            .then((data) => {
                // 仅当分类/分页未变化时保留预取结果
                if (ms.currentCat === tag.cat && ms.offset === tag.offset && ms.before === tag.before) {
                    ms.prefetched = data;
                }
            })
            .catch(() => { /* 预取失败静默，点击时走正常加载 */ })
            .finally(() => {
                ms.prefetching = false;
            });
    }

    renderPlaylists(playlists, isFirstPage) {
        const ms = this.getModeState();
        if (!playlists.length) {
            if (isFirstPage) {
                this.elements.playlists.innerHTML = '<div class="pl-empty">该分类暂无歌单</div>';
            }
            ms.gridHTML = this.elements.playlists.innerHTML;
            return;
        }
        const html = playlists.map((pl) => {
            const cover = this.coverUrl(pl.coverImgUrl);
            const name = pl.name || '未知歌单';
            return `
                <div class="pl-card" data-id="${pl.id}">
                    <div class="pl-cover">
                        <img src="${this.escapeHtml(cover)}" alt="${this.escapeHtml(name)}"
                             loading="lazy" onerror="this.style.display='none'">
                    </div>
                    <div class="pl-info">
                        <div class="pl-name" title="${this.escapeHtml(name)}">${this.escapeHtml(name)}</div>
                        <div class="pl-id" data-id="${pl.id}" title="点击复制歌单ID">
                            <span>ID: ${pl.id}</span>
                            <i class="ri-file-copy-line"></i>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        this.elements.playlists.insertAdjacentHTML('beforeend', html);
        ms.gridHTML = this.elements.playlists.innerHTML;
    }

    loadMore() {
        const ms = this.getModeState();
        if (ms.loading || !ms.hasMore) return;
        if (ms.prefetched) {
            // 使用滚动到底部时预取的数据，立即渲染，无需等待网络
            this.applyPageData(ms.prefetched);
            this.updateLoadMoreBar();
            return;
        }
        this.loadPlaylists();
    }

    /**
     * 压缩封面图片（网易云 CDN 支持 ?param= 参数），加快加载速度
     */
    coverUrl(url, size = 200) {
        const src = String(url || '').replace(/^http:\/\//i, 'https://');
        if (!src) return '';
        return `${src.split('?')[0]}?param=${size}y${size}`;
    }

    /** 复制歌单 ID 到剪贴板（Clipboard API 失败时降级 execCommand） */
    async copyId(id) {
        const text = String(id);
        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            console.error('剪贴板写入失败，使用降级方案:', error);
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        }
        this.player.showToast(`歌单ID ${text} 已复制`, 'success');
    }

    /** 点击歌单卡片：立即关闭弹窗并后台解析（/playlist/track/all） */
    async selectPlaylist(id) {
        // 点击反馈：卡片显示加载态，短暂延迟后关闭弹窗，解析在后台进行
        const card = this.elements.playlists.querySelector(`.pl-card[data-id="${id}"]`);
        if (card) card.classList.add('loading');
        this.player.showToast('正在加载歌单...', 'info');
        setTimeout(() => this.close(), 200);

        try {
            const data = await this.fetchJson(`${this.API_BASE}/playlist/track/all?id=${id}`);
            const songs = (data && data.songs) || [];
            if (!songs.length) {
                this.player.showToast('该歌单暂无歌曲', 'error');
                return;
            }
            const mapped = songs.map((s) => this.mapSong(s));
            // 预取第一首歌的播放链接，加快首次播放
            try {
                const first = mapped[0];
                const url = await this.player.fetchNcmApiPlayUrl(this.player.extractSongId(first));
                if (url) first.url = url;
            } catch (error) {
                console.error('预取播放链接失败:', error.message);
            }
            await this.player.loadPlaylist(mapped, String(id));
        } catch (error) {
            console.error('加载歌单歌曲失败:', error.message);
            this.player.showToast('歌单加载失败，请重试', 'error');
        }
    }

    /** 将 ncm-api 歌曲字段转换为播放器统一的歌曲格式 */
    mapSong(s) {
        const pic = this.coverUrl(s.al && s.al.picUrl, 300);
        return {
            title: s.name || '',
            author: (s.ar || []).map((a) => a.name).filter(Boolean).join(' / '),
            pic,
            url: '', // 播放链接由播放器后台降级接口自动获取
            lrc: `https://api.qijieya.cn/meting/?server=netease&type=lrc&id=${s.id}`
        };
    }

    /** HTML 转义，防止接口返回内容破坏页面结构 */
    escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[c]));
    }
}

// 初始化播放器
const player = new MusicPlayer();
// 初始化歌单浏览弹窗
const playlistBrowser = new PlaylistBrowser(player); 

