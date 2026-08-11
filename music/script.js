/* ============================================================
   音乐播放器（纯前端单页应用）
   ============================================================
   功能模块：
   - MusicPlayer：播放核心——歌单解析、播放控制、三种播放模式
     （顺序/随机/单曲循环）、歌词滚动、失败降级重试、播放链接缓存与预取
   - PlaylistBrowser：歌单浏览弹窗——分类与歌单列表浏览，选中歌单后
     交由 MusicPlayer 解析并播放

   API 分层（域名见 config.js）：
   - apiBase（meting-api）：歌单解析 / 播放链接 / 歌词 / 封面
   - playlistApiBase（ncm-api）：弹窗的分类 / 歌单列表
   ============================================================ */

// Toast 类型 → remixicon 图标名映射
const TOAST_ICONS = {
    success: 'checkbox-circle',
    error: 'error-warning',
    info: 'information'
};

/**
 * 播放器核心：管理歌曲列表、播放状态机与三种播放模式
 */
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
        
        // 下一首音频预加载元素：预热 CDN 连接与音频头部（metadata 模式），加快切歌
        this._preloadAudio = new Audio();
        this._preloadAudio.preload = 'metadata';
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
        this._backupFromCache = false; // 当前播放链接是否来自本地缓存（失效时清除重试）
        this._preloadDone = false; // 当前歌曲的下一首是否已预加载（幂等）
        
        // 播放模式：sequential(顺序/列表循环) / shuffle(随机) / loop(单曲循环)，刷新后保留上次选择
        this.playMode = this.loadPlayMode();
        this.shuffleOrder = []; // 随机模式播放序列（无重复）
        this.shuffleCursor = 0; // 随机序列当前游标
        this.modeMenuOpen = false;

        // meting 解析请求节流：串行执行 + 最小间隔，避免快速切歌时短时间突发请求
        // 触发服务端限流(429)。服务端滥用防护配置为 60 秒窗口最多 120 个请求
        // （平均每 500ms 1 个），客户端节流取 600ms 间隔（60 秒内 ≤ 101 个），
        // 预留窗口边界余量，防止恰好卡线触发封禁
        this._metingQueue = Promise.resolve();
        this._metingLastTs = 0;
        this._metingMinGap = 600; // 两个解析请求的最小间隔（ms）

        // meting 主备接口：主接口限流(429)时自动轮换到备用接口（首次 getApiBase 时载入）
        this._apiBases = [];
        this._activeApiIdx = 0;

        // 当前歌曲列表的音乐平台（播放/歌词/封面解析据此请求），默认网易云
        this.currentPlatform = 'netease';
    }
    
    /**
     * 从 localStorage 读取持久化的播放模式，非法值回退为顺序播放
     * @returns {'sequential'|'shuffle'|'loop'} 播放模式
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
        this.audio.addEventListener('loadeddata', () => this.cover.classList.remove('buffering'));
        // 音频真正开始播放：同步 UI 状态（降级恢复播放后不再残留"播放失败"态）
        this.audio.addEventListener('playing', () => {
            this._degrading = false; // 音频真正开始播放：解除降级标记
            this._playStarted = true;
            this.isPlaying = true;
            this.playBtn.innerHTML = '<i class="ri-pause-fill"></i>';
            this.failToken = null; // 播放已恢复，允许后续失败重新提示
            clearTimeout(this._errorTimer); // 播放已恢复，作废之前的错误验证定时器
            // 当前歌曲已稳定播放，此时再预加载下一首，避免与当前加载并发抢带宽
            // 注意：prefetchNextSongBackup 内部会置位 _preloadDone，此处不得提前置位
            this.prefetchNextSongBackup();
        });
        // 播放中出错（如网络中断）：延迟验证，仅在音频从未成功播放、不在降级流程、
        // 且无可用数据时才提示失败，避免降级缓冲期间误报
        this.audio.addEventListener('error', () => {
            const errToken = this.sourceToken; // 快照当前歌曲令牌，回调时校验是否已切歌
            clearTimeout(this._errorTimer);
            this._errorTimer = setTimeout(() => {
                // 已切歌则丢弃过期错误验证，防止新歌尚未开始播放时误报"播放失败"导致异常暂停
                if (errToken !== this.sourceToken) return;
                if (!this.isPlaying || this._degrading || !this.audio.paused) return;
                if (!this._playStarted && this.audio.readyState === 0) {
                    // 从未成功播放：确认为播放失败
                    this.showPlayFail();
                } else if (this._backupFromCache) {
                    // 曾正常播放但意外中断（如缓存的网易签名链接过期）：
                    // 清除过期缓存并重新解析重试，而非误报"播放失败"
                    this._backupFromCache = false;
                    const song = this.songs[this.currentIndex];
                    this.clearCachedBackupUrl(this.extractSongId(song));
                    this.fallbackAndPlay(errToken);
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

        // 音乐平台切换：同步更新输入框占位提示（网易云 / QQ音乐）
        const platformSelect = document.getElementById('platform-select');
        if (platformSelect) {
            platformSelect.addEventListener('change', () => {
                this.playlistInput.placeholder = platformSelect.value === 'tencent'
                    ? '输入QQ音乐歌单ID...'
                    : '输入网易云歌单ID...';
            });
        }
    }
    
    /* ---------- 播放模式控制 ---------- */
    
    /**
     * 模式图标映射：按钮图标与当前激活模式保持一致
     * sequential=顺序(列表循环) / shuffle=随机 / loop=单曲循环
     */
    MODE_ICONS = {
        sequential: 'ri-list-unordered',
        shuffle: 'ri-shuffle-line',
        loop: 'ri-repeat-one-line'
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
     * 构建无重复随机播放序列（Fisher-Yates 洗牌）
     * @param {number} [startIndex=currentIndex] 序列首元素索引（当前曲目固定为首位，
     *   保证整轮遍历不重复、且切歌后不会跳过当前曲目）
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
     * 随机模式：取无重复序列中的下一首索引（游标前进，越界后重新洗牌一次）
     * @returns {number} 下一首歌曲索引
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
     * 根据当前播放模式计算下一首索引（所有模式均保证有下一首）
     * @returns {number} 下一首歌曲索引
     */
    getNextIndex() {
        if (this.playMode === 'shuffle') {
            // 随机模式：取无重复随机序列中的下一首
            return this.nextShuffleIndex();
        }
        // 顺序 / 单曲循环：顺序推进，末尾循环回第一首
        // （单曲循环模式下自动播完不走此分支，由 nextSong 特判重播当前曲目）
        return (this.currentIndex + 1) % this.songs.length;
    }
    
    /**
     * 根据当前播放模式计算上一首索引（随机模式回退游标，其余模式循环取前一首）
     * @returns {number} 上一首歌曲索引
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
    
    /** 页面加载时自动恢复上次解析成功的歌单（不自动播放，由用户点击开始） */
    loadLastPlaylist() {
        const lastPlaylistId = localStorage.getItem('lastPlaylistId');
        if (lastPlaylistId) {
            this.playlistInput.value = lastPlaylistId;
            this.parsePlaylist('restore');
        }
    }
    
    /**
     * 解析歌单：从 meting-api 获取歌曲列表并载入播放器（不自动播放）
     * @param {'manual'|'restore'} [source='manual'] 触发来源：
     *   manual 为用户手动解析；restore 为页面加载自动恢复（失败时给出区分提示）
     */
    async parsePlaylist(source = 'manual') {
        const playlistId = this.playlistInput.value.trim();
        if (!playlistId) {
            this.showToast('请输入歌单ID', 'error');
            return;
        }
        
        try {
            this.parseBtn.disabled = true;
            this.parseBtn.textContent = '解析中...';
            
            // 歌单解析接口（meting-api，域名由 config.js 的 apiBase 配置）
            const songs = await this.fetchPlaylistSongs(playlistId);
            
            if (!songs.length) {
                throw { friendly: '无效的歌单ID或歌单为空' };
            }
            
            this.songs = songs;
            this.currentIndex = 0;
            this.renderPlaylist();
            await this.loadSong();
            
            // 解析成功后再持久化，避免坏 ID 每次刷新都自动重试
            localStorage.setItem('lastPlaylistId', playlistId);
            this.showToast(`成功加载 ${this.songs.length} 首歌曲`);
            this.songCount.textContent = `${this.songs.length} 首歌曲`;
            
        } catch (error) {
            // 自动恢复上次歌单失败时给出上下文提示，便于用户重新输入
            const msg = source === 'restore'
                ? '上次的歌单恢复失败，请重新输入歌单ID'
                : (error.friendly || '解析失败，请检查网络或歌单ID后重试');
            this.showToast(msg, 'error');
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
    
    /**
     * 加载 currentIndex 指向的歌曲（切歌核心流程）：
     * 1. 递增切歌令牌 sourceToken，使旧的异步降级任务结果失效
     * 2. 同步设置播放链接（song.url / 本地缓存），立即开始加载
     * 3. 后台解析播放链接（runSourceFallback）、预取下一首、加载歌词
     * 4. 若处于播放态则自动 play()，失败走降级重试
     */
    async loadSong() {
        if (!this.songs.length) return;
        
        const song = this.songs[this.currentIndex];
        this.sourceToken++; // 递增切歌令牌，使旧降级任务的结果失效
        const token = this.sourceToken;
        clearTimeout(this._errorTimer); // 清除上一首遗留的错误验证定时器，防止跨切歌误报暂停
        this._degrading = false; // 新歌开始：清空降级标记（若后续进入降级流程会重新置位）
        this._playStarted = false; // 新歌尚未真正开始播放
        this._preloadDone = false; // 新歌的下一首尚未预加载
        this.currentLyric = null;
        this.progressCurrent.style.width = '0%';
        this.currentTime.textContent = '00:00';
        this.duration.textContent = '00:00';
        
        this.songName.textContent = song.title || song.name;
        this.artistName.textContent = song.author || song.artist;
        // 封面兜底：加载失败显示内置占位图，避免破图
        this.cover.src = song.pic || '';
        this.cover.onerror = () => {
            this.cover.onerror = null;
            this.cover.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="%23eef1f8"/><text x="50%" y="50%" fill="%234f6ef7" font-size="72" text-anchor="middle" dominant-baseline="middle">♪</text></svg>';
        };
this.cover.classList.add('buffering'); // 切歌加载反馈，音频加载完成或链接获取结束后移除
        
        // 同步设置播放链接：优先本地缓存中解析出的真实音频地址（直接加载音乐 CDN，
        // 不再请求 meting）；无缓存时留空，由 runSourceFallback 节流解析后填充，
        // 避免每次切歌都加载 type=url 端点触发服务端限流(429)
        const songId = this.extractSongId(song);
        const cachedUrl = songId ? this.getCachedBackupUrl(songId) : '';
        this.audio.src = cachedUrl || '';
        this.runSourceFallback(song, token);
        // 并行预取当前歌曲的播放链接（写入缓存，供下次播放秒开）
        if (songId) {
            this.getPlayUrl(songId);
        }
        // 注意：不在此处预加载下一首——避免与当前歌曲加载并发抢带宽导致卡顿；
        // 改为当前歌曲稳定播放（playing 事件）或加载 3s 后（兜底）再预加载下一首
        setTimeout(() => {
            if (token === this.sourceToken && !this._preloadDone) {
                this.prefetchNextSongBackup();
            }
        }, 3000);
        
        // 同步播放列表高亮并滚动定位到当前播放歌曲
        this.syncPlaylistActive();
        
        // 歌词在后台加载，不能阻塞切歌后的音频播放；meting-api /api?type=lrc 返回纯文本歌词
        this.loadLyrics(song.lrc, token);

        if (this.isPlaying) {
            // 播放失败不立即提示：交由后台流程通过 meting-api 获取播放链接（成功则静默续播，失败才提示）
            this.audio.play().catch(() => this.fallbackAndPlay(token));
        }
    }
    
    /**
     * 后台获取播放链接并通过降级流程恢复播放
     * @param {object} song 当前歌曲对象
     * @param {number} token 发起时的切歌令牌，用于丢弃切歌后的过期结果
     */
    async runSourceFallback(song, token) {
        const songId = this.extractSongId(song);
        const playUrl = songId ? await this.getPlayUrl(songId) : '';
        if (token !== this.sourceToken) return; // 已切歌，丢弃过期结果
        this.cover.classList.remove('buffering'); // 链接获取结束，结束封面加载态
        if (!playUrl) {
            // 获取失败：若音频实际已在播放，静默保留
            if (this.isPlaying && !this.audio.paused && this.audio.readyState >= 2) {
                return;
            }
            // 仅当正在播放时才提示
            if (this.isPlaying) this.showPlayFail();
            return;
        }
        if (playUrl !== this.audio.getAttribute('src')) {
            this.audio.src = playUrl;
            // 替换 src 会中断当前播放，若处于播放态则恢复播放；
            // 恢复失败走降级流程（而非静默吞错），避免 isPlaying=true 但音频实际暂停的假播放态
            if (this.isPlaying) {
                this.audio.play().catch(() => this.fallbackAndPlay(token));
            }
        }
    }
    
    /**
     * 从歌曲对象中提取音乐 ID：
     * 依次从 url / lrc / pic 链接的 id 参数中提取，任一含 id 即返回
     * （网易云 ID 为纯数字，QQ 音乐 ID 可含字母，故按非空参数匹配）
     */
    extractSongId(song) {
        if (!song) return '';
        const pick = (u) => {
            const m = String(u || '').match(/[?&]id=([^&]+)/);
            return m ? m[1] : '';
        };
        return pick(song.url) || pick(song.lrc) || pick(song.pic);
    }
    
    /**
     * 获取播放链接（并发去重 + localStorage 24h 缓存）：
     * - 并发去重：runSourceFallback 与 fallbackAndPlay 共享同一请求
     * - 本地缓存：同一首歌重复播放直接复用，避免重复等待慢接口
     * @param {string} songId 音乐 ID
     * @returns {Promise<string>} 播放链接（meting-api url 端点），失败返回空串
     */
    getPlayUrl(songId) {
        if (!songId) return Promise.resolve('');
        if (this._backupSongId === songId && this._backupPromise) {
            return this._backupPromise;
        }
        const cached = this.getCachedBackupUrl(songId);
        if (cached) {
            this._backupFromCache = true;
            return Promise.resolve(cached);
        }
        this._backupFromCache = false;
        this._backupSongId = songId;
        this._backupPromise = this.fetchPlayUrl(songId)
            .then((url) => {
                if (url) this.setCachedBackupUrl(songId, url);
                return url;
            })
            .finally(() => {
                this._backupPromise = null;
                this._backupSongId = null;
            });
        return this._backupPromise;
    }

    /** 读取播放链接本地缓存（2h 内有效；旧版缓存的 meting 端点视为无效，需重新解析） */
    getCachedBackupUrl(songId) {
        try {
            const raw = localStorage.getItem('backupUrlCache');
            if (!raw) return '';
            const cache = JSON.parse(raw);
            const entry = cache[songId];
            if (!entry || !entry.t || !entry.url) return '';
            // 网易 CDN 音频地址带签名，有效期仅数小时：缓存采用 2 小时，
            // 超过即视为过期重新解析，避免播放到过期链接导致中断
            if (Date.now() - entry.t > 7200000) return '';
            // 旧版本缓存的是 meting type=url 端点（播放时仍会请求 meting），
            // 需重新解析为真实音频地址后缓存
            if (entry.url.includes('/api?server=')) return '';
            return entry.url;
        } catch (error) {
            return '';
        }
    }

    /** 写入播放链接本地缓存（限制条数，避免无限增长） */
    setCachedBackupUrl(songId, url) {
        try {
            const raw = localStorage.getItem('backupUrlCache');
            const cache = raw ? JSON.parse(raw) : {};
            cache[songId] = { t: Date.now(), url };
            const keys = Object.keys(cache);
            if (keys.length > 200) {
                delete cache[keys[0]];
            }
            localStorage.setItem('backupUrlCache', JSON.stringify(cache));
        } catch (error) {
            // 忽略缓存写入失败
        }
    }

    /** 清除某首歌的播放链接缓存（缓存链接失效时调用） */
    clearCachedBackupUrl(songId) {
        try {
            const raw = localStorage.getItem('backupUrlCache');
            if (!raw) return;
            const cache = JSON.parse(raw);
            if (cache[songId]) {
                delete cache[songId];
                localStorage.setItem('backupUrlCache', JSON.stringify(cache));
            }
        } catch (error) {
            // 忽略
        }
    }
    
    /**
     * 读取当前歌曲列表的音乐平台（currentPlatform，解析歌单时记录）：
     * 播放链接 / 歌词 / 封面解析据此请求对应平台的接口
     * @returns {'netease'|'tencent'} 平台标识
     */
    getPlatform() {
        return this.currentPlatform === 'tencent' ? 'tencent' : 'netease';
    }

    /**
     * 读取解析栏下拉框选中的音乐平台（下次解析歌单使用，默认网易云）
     * @returns {'netease'|'tencent'} 平台标识
     */
    getSelectPlatform() {
        const el = document.getElementById('platform-select');
        return el && el.value === 'tencent' ? 'tencent' : 'netease';
    }

    /**
     * 读取当前生效的歌曲接口地址（meting-api 主备之一，config.js 配置）：
     * 歌单解析 / 播放链接 / 歌词 / 封面均走此接口；主接口 429 限流时
     * 由 switchApiBase 轮换到备用接口，后续请求自动使用新地址
     */
    getApiBase() {
        const cfg = (typeof window !== 'undefined' && window.NCM_CONFIG) || {};
        const primary = cfg.apiBase || 'https://meting.xyf111.top';
        const backup = cfg.apiBaseBackup || 'http://8.130.9.143:3000';
        // 首次调用时载入主备地址表（保持幂等，避免重复初始化）
        if (!this._apiBases.length) {
            this._apiBases = [primary, backup];
        }
        return this._apiBases[this._activeApiIdx] || primary;
    }

    /**
     * 轮换到下一个 meting 接口（主接口 429 限流时切换备用接口）
     * @returns {string} 切换后生效的接口地址
     */
    switchApiBase() {
        this.getApiBase(); // 确保地址表已初始化
        if (this._apiBases.length < 2) return this._apiBases[0];
        this._activeApiIdx = (this._activeApiIdx + 1) % this._apiBases.length;
        return this._apiBases[this._activeApiIdx];
    }

    /**
     * 读取歌单浏览弹窗 API 服务地址（config.js 中 playlistApiBase 配置，ncm-api）：
     * 弹窗的分类与歌单列表接口保持不变，仅此一处使用
     */
    getPlaylistApiBase() {
        const cfg = (typeof window !== 'undefined' && window.NCM_CONFIG) || {};
        return cfg.playlistApiBase || 'https://ncm-api.prod.gbclstudio.cn';
    }

    /**
     * 统一 http → https，避免混合内容被浏览器拦截
     */
    toHttps(url) {
        return String(url || '').replace(/^http:\/\//i, 'https://');
    }

    /**
     * 获取歌单歌曲列表（meting-api /api?type=playlist）并记录为当前列表平台
     * @param {string} playlistId 歌单 ID
     * @param {'netease'|'tencent'} [server] 音乐平台，默认取解析栏当前选择
     * @returns {Promise<Array>} 已转换为播放器统一格式的歌曲数组
     */
    async fetchPlaylistSongs(playlistId, server = this.getSelectPlatform()) {
        // 记录当前列表平台：播放/歌词/封面解析统一按该平台请求
        this.currentPlatform = server === 'tencent' ? 'tencent' : 'netease';
        // 走节流队列：主接口 429 时自动切换备用接口重试
        const response = await this._throttledFetch(
            `${this.getApiBase()}/api?server=${server}&type=playlist&id=${encodeURIComponent(playlistId)}`
        );
        if (!response.ok) throw { friendly: '网络异常，请稍后重试' };
        const data = await response.json();
        // meting-api 返回歌曲数组；兼容旧 ncm-api 的 { songs: [...] } 结构
        const songs = Array.isArray(data) ? data : (data && data.songs) || [];
        return songs.map((s) => this.mapSong(s));
    }

    /**
     * 将接口歌曲字段转换为播放器统一的歌曲格式
     * （meting-api：title/author/pic/url/lrc；兼容 ncm-api：name/ar/al）
     */
    mapSong(s) {
        const pic = this.coverUrl(s.pic || (s.al && s.al.picUrl), 300);
        return {
            title: s.title || s.name || '',
            author: s.author || (s.ar || []).map((a) => a.name).filter(Boolean).join(' / '),
            pic,
            // 播放链接：meting-api 返回的 url 端点，浏览器自动跟随 302 重定向到音频地址
            url: this.toHttps(s.url || ''),
            lrc: this.toHttps(s.lrc || (s.id
                ? `${this.getApiBase()}/api?server=${this.getPlatform()}&type=lrc&id=${s.id}` : ''))
        };
    }

    /** 压缩封面图片（网易云 CDN 支持 ?param= 参数），加快加载速度 */
    coverUrl(url, size = 300) {
        const src = this.toHttps(url);
        if (!src) return '';
        return `${src.split('?')[0]}?param=${size}y${size}`;
    }

    /**
     * 预取"下一首"的播放链接：提前发起请求并写入本地缓存，
     * 点击下一首时大概率已就绪（缓存命中），大幅缩短切歌等待时间
     */
    prefetchNextSongBackup() {
        if (this._preloadDone) return; // 幂等：每首歌只预加载一次
        this._preloadDone = true;
        if (!this.songs || this.songs.length < 2) return;
        let nextIndex;
        if (this.playMode === 'shuffle') {
            // 随机模式：预取随机序列中的下一首（不推进游标）
            if (!this.shuffleOrder.length) this.buildShuffleOrder();
            const n = this.shuffleOrder[this.shuffleCursor + 1];
            nextIndex = n !== undefined ? n : this.shuffleOrder[0];
        } else {
            // 顺序/单曲循环模式：手动切歌均顺序推进并循环，预取下一首即可
            nextIndex = (this.currentIndex + 1) % this.songs.length;
        }
        if (nextIndex === this.currentIndex) return;
        const nextItem = this.songs[nextIndex];
        if (!nextItem) return;
        const nextId = this.extractSongId(nextItem);
        if (nextId) {
            // 预取下一首的播放链接（节流解析真实音频地址并写入缓存）；
            // 仅当解析出真实音频地址（非 meting 端点）时才用隐藏 Audio 预热 CDN，
            // 避免预取加载端点额外占用 meting 请求配额
            this.getPlayUrl(nextId).then((url) => {
                if (url && !url.includes('/api?server=') && this._preloadAudio) {
                    this._preloadAudio.src = url;
                }
            });
        }
    }
    
    /**
     * 节流请求：所有 meting 解析请求（播放链接/歌词/歌单）串行执行，
     * 且与上一次请求间隔 ≥ _metingMinGap，防止快速切歌时突发请求触发限流(429)；
     * 请求返回 429 时自动轮换到备用接口并立即重试当前请求
     * @param {string} url 请求地址
     * @param {object} [options] fetch 选项
     * @returns {Promise<Response>}
     */
    _throttledFetch(url, options = {}) {
        const run = async () => {
            const elapsed = Date.now() - this._metingLastTs;
            if (elapsed < this._metingMinGap) {
                await new Promise((r) => setTimeout(r, this._metingMinGap - elapsed));
            }
            this._metingLastTs = Date.now();
            const activeBase = this.getApiBase();
            let response = await fetch(url, options);
            // 主接口限流(429)：切换到备用接口并重试当前请求（备用也 429 时轮换回主）
            if (response.status === 429) {
                const nextBase = this.switchApiBase();
                if (nextBase && nextBase !== activeBase) {
                    const retryUrl = url.replace(activeBase, nextBase);
                    response = await fetch(retryUrl, options);
                }
            }
            return response;
        };
        const task = this._metingQueue.then(run, run);
        this._metingQueue = task.catch(() => {}); // 队列不因单个请求失败而中断
        return task;
    }

    /**
     * 解析歌曲播放链接（meting-api /api?server=当前平台&type=url）：
     * 端点返回 302 重定向到真实音频地址，此处用 HEAD + 跟随重定向解析出
     * 真实 mp3 地址并缓存，之后播放/预取直接加载音乐 CDN，不再请求 meting，
     * 避免频繁切歌触发服务端限流(429)
     * @param {string} songId 音乐 ID
     * @returns {Promise<string>} 真实音频地址；解析失败返回空串
     */
    async fetchPlayUrl(songId) {
        if (!songId) return '';
        const url = `${this.getApiBase()}/api?server=${this.getPlatform()}&type=url&id=${encodeURIComponent(songId)}`;
        try {
            // HEAD + 跟随重定向：拿到最终音频地址，不下载音频内容
            let response = await this._throttledFetch(url, { method: 'HEAD', redirect: 'follow' });
            if (response.ok && response.url && !response.url.includes('/api?server=')) {
                return response.url;
            }
            // HEAD 不被支持（如 405）时回退 GET：获取地址后立即取消 body 下载
            response = await this._throttledFetch(url, { redirect: 'follow' });
            if (!response.ok || !response.url || response.url.includes('/api?server=')) return '';
            if (response.body && typeof response.body.cancel === 'function') {
                response.body.cancel();
            }
            return response.url;
        } catch (error) {
            console.error('播放链接解析失败:', error.message);
            return '';
        }
    }
    
    /**
     * 后台加载歌词并解析（异步，不阻塞切歌后的音频播放）
     * @param {string} url 歌词接口地址（meting-api /api?type=lrc，返回纯文本）
     * @param {number} token 切歌令牌，切歌后丢弃过期歌词结果
     */
    async loadLyrics(url, token) {
        const lrcController = new AbortController();
        const lrcTimer = setTimeout(() => lrcController.abort(), 8000);
        try {
            // 歌词请求同样走节流队列，避免与播放链接解析叠加触发限流(429)
            const response = await this._throttledFetch(url, { signal: lrcController.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            // meting-api /api?type=lrc 返回纯文本歌词（含翻译合并），直接按行解析
            const lrcText = await response.text();
            if (token === this.sourceToken) {
                this.parseLyric(lrcText);
            }
        } catch (error) {
            console.error('Error loading lyrics:', error);
            if (token === this.sourceToken) {
                // 区分"无歌词"与"加载失败"，便于用户感知并重试
                this.lyricsContainer.innerHTML = '<p class="empty-lyrics">歌词加载失败</p>';
            }
        } finally {
            clearTimeout(lrcTimer);
        }
    }

    /**
     * 将 LRC 纯文本解析为 {time, text} 数组并渲染
     * @param {string} lrcText LRC 歌词文本（每行 [mm:ss.xx] 时间戳 + 内容）
     */
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
    
    /** 渲染歌词列表到容器（无歌词时显示占位文案） */
    renderLyrics() {
        if (!this.lyrics.length) {
            this.lyricsContainer.innerHTML = '<p class="empty-lyrics">暂无歌词</p>';
            return;
        }
        
        this.lyricsContainer.innerHTML = this.lyrics
            .map(lyric => `<p class="lyrics-line" data-time="${lyric.time}">${this.escapeHtml(lyric.text)}</p>`)
            .join('');
    }
    
    /**
     * 根据当前播放进度高亮对应歌词行（仅在新歌词行变化时更新，避免重复滚动）
     * @param {number} currentTime 当前播放时间（秒）
     */
    updateLyrics(currentTime) {
        if (!this.lyrics.length) return;
        
        const currentLyric = this.lyrics.find((lyric, index) => {
            const nextLyric = this.lyrics[index + 1];
            return currentTime >= lyric.time && (!nextLyric || currentTime < nextLyric.time);
        });
        
        // 高亮变化时更新：currentLyric 为 undefined（当前时间早于首行时间戳，
        // 如单曲循环重播开头）时清空所有高亮，避免停留在上一遍的结尾行
        if (currentLyric !== this.currentLyric) {
            this.currentLyric = currentLyric || null;
            const allLines = this.lyricsContainer.querySelectorAll('.lyrics-line');
            allLines.forEach(line => line.classList.remove('active'));
            if (currentLyric) {
                const activeLine = this.lyricsContainer.querySelector(`[data-time="${currentLyric.time}"]`);
                if (activeLine) {
                    activeLine.classList.add('active');
                    activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }
    }
    
    /**
     * 播放/暂停切换（用户点击播放按钮触发）：
     * - 暂停：直接 pause 并同步 UI
     * - 播放：设置 UI 后 play()，失败则走降级流程获取链接重试
     */
    togglePlay() {
        if (this.isPlaying) {
            this.audio.pause();
            this.playBtn.innerHTML = '<i class="ri-play-fill"></i>';
            this.isPlaying = false;
        } else {
            this.playBtn.innerHTML = '<i class="ri-pause-fill"></i>';
            this.isPlaying = true;
            // 若当前链接无效，play() 会失败，此时通过 meting-api 获取播放链接再试
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
     * 播放失败时的重试：通过 meting-api 获取播放链接重新播放；
     * token 校验防止切歌后旧任务结果覆盖新歌
     */
    async fallbackAndPlay(token) {
        const song = this.songs[this.currentIndex];
        if (!song) {
            this.showPlayFail();
            return;
        }
        this._degrading = true; // 降级期间屏蔽 error 误报；由 playing 事件或失败路径解除
        try {
            const songId = this.extractSongId(song);
            const playUrl = songId ? await this.getPlayUrl(songId) : '';
            if (token !== this.sourceToken) {
                // 已切歌，丢弃过期结果。
                // 注意：不重置 _degrading——新歌的降级任务可能仍在进行，
                // 旧任务重置会导致 error 定时器误报"播放失败"
                return;
            }
            this.cover.classList.remove('buffering');
            if (!playUrl) {
                // meting-api 获取失败：统一提示（按歌去重）
                this._degrading = false;
                this.showPlayFail();
                return;
            }
            this.audio.src = playUrl;
            this.audio.play().catch(() => {
                if (token !== this.sourceToken) return; // 切歌后旧任务失败不再提示
                // 播放链接失败：若来自本地缓存，可能是链接已过期，清除缓存后重试一次
                if (this._backupFromCache) {
                    this._backupFromCache = false;
                    this.clearCachedBackupUrl(songId);
                    return this.fallbackAndPlay(token);
                }
                this._degrading = false;
                this.showPlayFail();
            });
            // 注意：play() 成功后不立即解除 _degrading，等 playing 事件（音频真正开始播放）
            // 再解除，避免链接缓冲期间 error 定时器误报"播放失败"
        } catch (error) {
            if (token === this.sourceToken) this._degrading = false;
        }
    }
    
    /**
     * 播放入口：切换当前索引并加载播放（暂停状态下也自动开始播放）
     * @param {number} index 目标歌曲在列表中的索引
     */
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
    
    /** 手动切到上一首（暂停状态下也自动开始播放） */
    async prevSong() {
        if (!this.songs.length) return;
        this.currentIndex = this.getPrevIndex();
        await this.loadSong();
        // 手动切歌：暂停状态下也自动开始播放
        if (!this.isPlaying) this.togglePlay();
    }
    
    /**
     * 切到下一首；单曲循环模式下自动播完重播当前歌曲
     * @param {boolean} [fromAuto=false] 是否由 ended 事件触发
     */
    async nextSong(fromAuto = false) {
        if (!this.songs.length) return;
        // 单曲循环：自动播完重复当前歌曲（不切歌、不重新加载，直接从头重播）
        if (this.playMode === 'loop' && fromAuto) {
            // 重置歌词高亮并回到顶部，避免重播开头仍停留在上一遍的结尾行
            this.currentLyric = null;
            this.lyricsContainer.querySelectorAll('.lyrics-line').forEach((line) => line.classList.remove('active'));
            const wrapper = this.lyricsContainer.closest('.lyrics-wrapper');
            if (wrapper) wrapper.scrollTop = 0;
            this.audio.currentTime = 0;
            this.audio.play().catch(() => {});
            return;
        }
        this.currentIndex = this.getNextIndex();
        await this.loadSong();
        // 手动切歌：暂停状态下也自动开始播放
        if (!this.isPlaying) this.togglePlay();
    }
    
    /** 音频 timeupdate 事件：刷新进度条、时间显示与歌词高亮 */
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
    
    /** 点击进度条跳转播放位置（按点击横坐标比例计算目标时间） */
    setProgress(e) {
        const width = this.progress.clientWidth;
        const duration = this.audio.duration;
        // 未加载（duration 无效）时忽略点击，避免写入 NaN
        if (!width || !isFinite(duration) || duration <= 0) return;
        const ratio = Math.min(Math.max(e.offsetX / width, 0), 1);
        this.audio.currentTime = ratio * duration;
    }
    
    /** 秒数格式化为 mm:ss（时长无效时由调用方兜底为 00:00） */
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

/* ============================================================
   歌单浏览弹窗 PlaylistBrowser
   - 分类与歌单列表接口保持 ncm-api 不变（config.js 的 playlistApiBase）
   - 选中歌单后的歌曲解析走 meting-api（与输入框解析一致）
   - 支持普通/精品两种板块，各自独立缓存分类、分页与列表数据
   ============================================================ */

/**
 * 歌单浏览弹窗：分类筛选、歌单列表浏览（含分页预取与缓存）、
 * 点击歌单后交由 MusicPlayer 解析并播放
 */
class PlaylistBrowser {
    constructor(player) {
        this.player = player;
        // 弹窗接口（分类/歌单列表）保持 ncm-api 不变（config.js 的 playlistApiBase）
        this.API_BASE = this.player.getPlaylistApiBase();
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
     * 请求弹窗接口（ncm-api）并解析 JSON（自动重试 + 超时 + 响应校验）：
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

    /** 渲染当前模式的分类标签栏（含当前选中态高亮） */
    renderCats() {
        const ms = this.getModeState();
        this.elements.cats.innerHTML = ms.cats.map((cat) => `
            <button type="button" class="cat-chip ${cat.name === ms.currentCat ? 'active' : ''}"
                    data-cat="${this.escapeHtml(cat.name)}">${this.escapeHtml(cat.name)}</button>
        `).join('');
    }

    /** 切换分类：重置分页状态并重新加载该分类下的歌单列表 */
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
            // 错误详情透出（截断过长），便于用户定位是网络/接口/歌单问题
            const detail = error && error.message ? `：${String(error.message).slice(0, 40)}` : '';
            this.player.showToast(`歌单加载失败${detail}，请重试`, 'error');
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

    /** 渲染一页歌单卡片（追加到列表；首页时清空；空列表显示占位文案） */
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

    /** 加载更多：优先使用滚动预取数据（立即渲染），否则发起新请求 */
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

    /** 点击歌单卡片：立即关闭弹窗并后台解析（歌单解析走 meting-api，与输入框解析一致） */
    async selectPlaylist(id) {
        // 点击反馈：卡片显示加载态，短暂延迟后关闭弹窗，解析在后台进行
        const card = this.elements.playlists.querySelector(`.pl-card[data-id="${id}"]`);
        if (card) card.classList.add('loading');
        this.player.showToast('正在加载歌单...', 'info');
        setTimeout(() => this.close(), 200);

        try {
            // 弹窗列表均为网易云歌单：解析固定使用 netease，不受解析栏平台选择影响
            const songs = await this.player.fetchPlaylistSongs(id, 'netease');
            if (!songs.length) {
                this.player.showToast('该歌单暂无歌曲', 'error');
                return;
            }
            // 预取第一首歌的播放链接，加快首次播放
            try {
                const first = songs[0];
                const url = await this.player.getPlayUrl(this.player.extractSongId(first));
                if (url) first.url = url;
            } catch (error) {
                console.error('预取播放链接失败:', error.message);
            }
            await this.player.loadPlaylist(songs, String(id));
        } catch (error) {
            console.error('加载歌单歌曲失败:', error.message);
            const detail = error && error.message ? `：${String(error.message).slice(0, 40)}` : '';
            this.player.showToast(`歌单加载失败${detail}，请重试`, 'error');
        }
    }

    /** 将接口歌曲字段转换为播放器统一的歌曲格式（复用 MusicPlayer.mapSong） */
    mapSong(s) {
        return this.player.mapSong(s);
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

