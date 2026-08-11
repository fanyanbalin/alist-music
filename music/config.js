/* ============================================================
   播放器 API 配置
   ============================================================
   纯静态项目，接口域名直接在此配置：
   - apiBase / apiBaseBackup：歌曲相关接口（歌单解析 / 播放链接 / 歌词 / 封面），
     使用 meting-api。apiBase 为线上域名，apiBaseBackup 为其反向代理的
     源站直连地址（同一服务，参数完全一致）；主接口限流(429)时自动切换备用
   - playlistApiBase：歌单浏览弹窗接口（分类 / 歌单列表），
     保持 ncm-api（https://ncm-api.prod.gbclstudio.cn）不变
   修改后刷新页面即可生效（无需改主代码 script.js）。
   ============================================================ */
window.NCM_CONFIG = {
    // 歌曲相关接口（meting-api 主备）：支持 /api?server=netease&type=playlist|url|lrc|pic
    apiBase: 'https://meting.xyf111.top',
    // 备用：主接口反向代理的源站直连，绕过代理层限流（页面为 https 部署时
    // 浏览器会拦截 http 混合内容，届时请改用支持 https 的备用地址）
    apiBaseBackup: 'http://8.130.9.143:3000',

    // 歌单浏览弹窗接口（分类 / 歌单列表）：保持 ncm-api 不变
    playlistApiBase: 'https://ncm-api.prod.gbclstudio.cn'
};