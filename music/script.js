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
        this.audio.addEventListener('ended', () => this.nextSong());
        
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
     * 根据当前播放模式计算下一首索引；返回 -1 表示播放结束（顺序模式播完最后一首）
     */
    getNextIndex() {
        if (this.playMode === 'sequential') {
            return this.currentIndex >= this.songs.length - 1 ? -1 : this.currentIndex + 1;
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
    
    showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <i class="ri-${type === 'success' ? 'checkbox-circle' : 'error-warning'}-line"></i>
            <span>${message}</span>
        `;
        
        this.toastContainer.appendChild(toast);
        
        setTimeout(() => {
            toast.remove();
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
            
            localStorage.setItem('lastPlaylistId', playlistId);
            
            const response = await fetch(`https://api.qijieya.cn/meting/?type=playlist&id=${playlistId}`);
            const data = await response.json();
            
            if (!Array.isArray(data) || data.length === 0) {
                throw new Error('无效的歌单ID或歌单为空');
            }
            
            this.songs = data;
            this.currentIndex = 0;
            this.renderPlaylist();
            await this.loadSong();
            
            this.showToast(`成功加载 ${data.length} 首歌曲`);
            this.songCount.textContent = `${data.length} 首歌曲`;
            
        } catch (error) {
            this.showToast(error.message || '解析失败，请重试', 'error');
            console.error('Error parsing playlist:', error);
        } finally {
            this.parseBtn.disabled = false;
            this.parseBtn.textContent = '解析';
        }
    }
    
    renderPlaylist() {
        // 全量渲染播放列表（歌单加载/切换时调用）
        this.playlist.innerHTML = this.songs.map((song, index) => `
            <li class="${index === this.currentIndex ? 'active' : ''}" 
                onclick="player.playSong(${index})">
                <div class="song-index">${(index + 1).toString().padStart(2, '0')}</div>
                <div class="song-details">
                    <div class="song-name">${song.title || song.name}</div>
                    <div class="song-artist">${song.author || song.artist}</div>
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
        
        this.songName.textContent = song.title || song.name;
        this.artistName.textContent = song.author || song.artist;
        this.cover.src = song.pic;
        
        // 同步设置主接口播放链接，保证点击播放即时响应；
        // 随后后台静默降级探测：主接口无效时自动切换备用接口，不阻塞用户操作
        this.audio.src = song.url || '';
        this.runSourceFallback(song, token);
        
        // 同步播放列表高亮并滚动定位到当前播放歌曲
        this.syncPlaylistActive();
        
        // 加载歌词
        try {
            const response = await fetch(song.lrc);
            const lrcText = await response.text();
            if (token === this.sourceToken) {
                this.parseLyric(lrcText);
            }
        } catch (error) {
            console.error('Error loading lyrics:', error);
            if (token === this.sourceToken) {
                this.lyricsContainer.innerHTML = '<p class="empty-lyrics">暂无歌词</p>';
            }
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
        // 1) 主播放接口
        const mainUrl = song.url || '';
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
        if (!playUrl) {
            // 主、备用接口均失败：仅当正在播放时才提示
            if (this.isPlaying) this.showPlayFail();
            return;
        }
        if (playUrl !== this.audio.getAttribute('src')) {
            this.audio.src = playUrl;
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
     * 1) ncm-api 鉴权接口（需带 Cookie，Chrome 120+ 须 credentials:'include' 以携带第三方鉴权会话）
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
     * ncm-api 鉴权播放链接接口：
     * - 须携带 Cookie，Chrome 120+ 默认拦截第三方 Cookie，故加 credentials:'include'
     * - 返回的链接可能为 http，统一转为 https 以保证浏览器可播
     */
    async fetchNcmApiPlayUrl(songId) {
        if (!songId) return '';
        const response = await fetch(
            `https://ncm-api.prod.gbclstudio.cn/song/url/v1?id=${songId}`,
            { credentials: 'include' }
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
            const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
            if (match) {
                const time = parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / 1000;
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
            .map(lyric => `<p class="lyrics-line" data-time="${lyric.time}">${lyric.text}</p>`)
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
        const playUrl = await this.ensurePlayUrl(song);
        if (token !== this.sourceToken) return; // 已切歌，丢弃过期结果
        if (!playUrl) {
            // 主、备用接口均失败：统一提示（按歌去重）
            this.showPlayFail();
            return;
        }
        this.audio.src = playUrl;
        this.audio.play().catch(() => this.showPlayFail());
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
    }
    
    async nextSong() {
        if (!this.songs.length) return;
        const nextIndex = this.getNextIndex();
        if (nextIndex === -1) {
            // 顺序播放：已到列表最后一首，停止播放
            this.audio.pause();
            this.audio.currentTime = 0;
            this.playBtn.innerHTML = '<i class="ri-play-fill"></i>';
            this.isPlaying = false;
            return;
        }
        this.currentIndex = nextIndex;
        await this.loadSong();
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
        const clickX = e.offsetX;
        const duration = this.audio.duration;
        this.audio.currentTime = (clickX / width) * duration;
    }
    
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

// 初始化播放器
const player = new MusicPlayer(); 

