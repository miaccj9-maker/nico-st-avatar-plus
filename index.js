/* ============================================================
 * SillyTavern 扩展：头像裁剪 + 动态头像（合并版）
 * nico-st-avatar-plus v1.7.2
 *
 * v1.4.0 双击进入拖动模式，默认锁定，杜绝误触
 * v1.5.0 原生头像同引擎 + 按最终像素重绘（放大不糊）+ 重渲染巡检
 * v1.6.0 面具/存档完全独立 + 本地缓存 + 新楼层不再闪原始头像
 * v1.7.0 ★ 合并 avatar-cropper：点角色/面具头像即可选本机图片或视频
 *        ★ 图片按 2:3 裁剪后【写入酒馆原生头像】，不再出现"侧栏一套、聊天一套"
 *        ★ 恢复存档位置时不再重新 clamp（修掉"位置被打回原位"的老毛病）
 *        ★ "恢复原生头像"与"重置位置与缩放"分离
 *        ★ 面板入口：角色界面头像、面具界面 Set Image 按钮
 * v1.7.1 ★ 拖动不再丢帧（同帧多次移动取最新坐标；松手前 flush 最后一帧）
 *        ★ 新楼层插入瞬间先摆好位移，避免"先闪原位置再跳"
 *        ★ 面具唯一 ID 记住上次成功解析值，页面刚启动也不会错档
 *        ★ 弹窗按钮基础样式补齐，底部 4 个按钮不再回到系统默认方块
 * v1.7.2 ★ 弹窗改为极简黑白（无彩色 accent，白色主按钮）
 *        ★ 高度自适应：max-height 用 dvh + 内容区独立滚动，矮屏/手机不再溢出
 *        ★ 底部改为"次要按钮一行 + 应用整行"，窄屏不挤不换行
 *
 * 存储键（不改名，兼容历史数据）：
 *   st_avatar_video_urls / st_avatar_positions / st_avatar_scales
 *   IndexedDB ST_Avatar_Local_DB v2 / store: avatar_files
 * ============================================================ */
(function () {
    'use strict';

    /* ========== 存储键名 / 常量 ========== */
    const VIDEO_KEY = 'st_avatar_video_urls';
    const POS_KEY = 'st_avatar_positions';
    const SCALE_KEY = 'st_avatar_scales';
    const DB_NAME = 'ST_Avatar_Local_DB';
    const DB_STORE = 'avatar_files';

    const MIN_SCALE = 1.0;
    const MAX_SCALE = 4.5;
    const SCALE_STEP = 0.15;

    /* 原生头像固定 2:3，输出不放大、上限 2048，保证放大后依旧清晰 */
    const AV_H_PER_W = 1.5;
    const AV_MAX_H = 2048;
    const AV_MIN_H = 320;

    /* ========== 内存缓存 ========== */
    const mediaCache = new Map();   // key -> { src, isLocal, type } | null
    const posCache = new Map();     // key -> { x, y }
    const scaleCache = new Map();   // key -> number

    /* ========== 会话 / 存档感知 ========== */
    let lastGoodChatId = '';

    function resolveChatId() {
        try {
            if (window.SillyTavern?.getContext) {
                const ctx = window.SillyTavern.getContext();
                if (ctx.chatId) return String(ctx.chatId);
                if (ctx.characterId !== undefined && ctx.chatId !== undefined) {
                    return `${ctx.characterId}_${ctx.chatId}`;
                }
            }
        } catch (e) { /* 忽略上下文读取失败，退回 DOM 探测 */ }
        const chatSelect = document.getElementById('selected_chat');
        if (chatSelect && chatSelect.value) return String(chatSelect.value);
        const activeItem = document.querySelector('#chat_history .chat_history_item.active');
        if (activeItem && activeItem.getAttribute('data-id')) {
            return String(activeItem.getAttribute('data-id'));
        }
        return '';
    }

    function getChatId() {
        const got = resolveChatId();
        if (got) {
            lastGoodChatId = got;
            return got;
        }
        return lastGoodChatId || 'global_chat';
    }

    /* 独立面具（persona / 角色）+ 独立存档（chat）：
       键 = chatId::(u=用户面具 / c=角色)::名字。 */
    function makeKey(name, isUser) {
        return `${getChatId()}::${isUser ? 'u' : 'c'}::${name}`;
    }

    /* ========== 1. IndexedDB 异步二进制存储 ========== */
    let dbPromise = null;

    function getDB() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 2);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return dbPromise;
    }

    async function saveLocalFile(key, fileBlob) {
        try {
            const db = await getDB();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(DB_STORE, 'readwrite');
                tx.objectStore(DB_STORE).put(fileBlob, key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('[头像扩展] 本地文件保存失败', e);
            return false;
        }
    }

    async function getLocalFile(key, fallbackName) {
        try {
            const db = await getDB();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(DB_STORE, 'readonly');
                const store = tx.objectStore(DB_STORE);
                const req = store.get(key);
                req.onsuccess = () => {
                    if (req.result) {
                        resolve(req.result);
                    } else if (fallbackName) {
                        const fbReq = store.get(fallbackName);
                        fbReq.onsuccess = () => resolve(fbReq.result || null);
                        fbReq.onerror = () => reject(fbReq.error);
                    } else {
                        resolve(null);
                    }
                };
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            return null;
        }
    }

    async function deleteLocalFile(key) {
        try {
            const db = await getDB();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(DB_STORE, 'readwrite');
                tx.objectStore(DB_STORE).delete(key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            return false;
        }
    }

    /* ========== 2. 状态读写 ========== */
    const load = (k) => {
        try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; }
    };
    const save = (k, d) => {
        try { localStorage.setItem(k, JSON.stringify(d)); } catch (e) { /* 配额满了就别拦着用户 */ }
    };

    /* 新键带 u/c 前缀；读时回退到旧键（v1.5 及更早），避免老设置丢失 */
    function storageKeys(name, isUser) {
        return [makeKey(name, isUser), `${getChatId()}::${name}`];
    }

    const getVideoUrl = (name, isUser) => {
        const store = load(VIDEO_KEY);
        const [k, oldK] = storageKeys(name, isUser);
        return store[k] || store[oldK] || store[name] || '';
    };

    const setVideoUrl = (name, url, isUser) => {
        const d = load(VIDEO_KEY);
        const k = makeKey(name, isUser);
        if (url) d[k] = url;
        else delete d[k];
        save(VIDEO_KEY, d);
        mediaCache.delete(k);
    };

    const getPos = (name, isUser) => {
        const [k, oldK] = storageKeys(name, isUser);
        if (posCache.has(k)) return posCache.get(k);
        const store = load(POS_KEY);
        const p = store[k] || store[oldK] || store[name];
        const val = p ? { x: Number(p.x) || 0, y: Number(p.y) || 0 } : { x: 0, y: 0 };
        posCache.set(k, val);
        return val;
    };

    const setPos = (name, x, y, isUser) => {
        const d = load(POS_KEY);
        const k = makeKey(name, isUser);
        d[k] = { x, y };
        save(POS_KEY, d);
        posCache.set(k, { x, y });
    };

    const getScale = (name, isUser) => {
        const [k, oldK] = storageKeys(name, isUser);
        if (scaleCache.has(k)) return scaleCache.get(k);
        const store = load(SCALE_KEY);
        const val = Number(store[k] || store[oldK] || store[name]) || 1.0;
        scaleCache.set(k, val);
        return val;
    };

    const setScale = (name, s, isUser) => {
        const d = load(SCALE_KEY);
        const k = makeKey(name, isUser);
        if (s && s > MIN_SCALE) d[k] = s;
        else delete d[k];
        save(SCALE_KEY, d);
        scaleCache.set(k, s || 1.0);
    };

    /* 切换存档 / 换角色时清空内存缓存，避免串档 */
    function clearAllCaches() {
        mediaCache.clear();
        posCache.clear();
        scaleCache.clear();
    }

    const activeBlobUrls = new Map();

    async function resolveAvatarSource(name, isUser) {
        const k = makeKey(name, isUser);
        /* 内存缓存命中：同步返回，不再等 IndexedDB，避免新楼层闪一下 */
        if (mediaCache.has(k)) return mediaCache.get(k);

        const localBlob = await getLocalFile(k, null);
        let result = null;
        if (localBlob) {
            if (activeBlobUrls.has(k)) {
                try { URL.revokeObjectURL(activeBlobUrls.get(k)); } catch (e) { /* ignore */ }
            }
            const blobUrl = URL.createObjectURL(localBlob);
            activeBlobUrls.set(k, blobUrl);
            result = { src: blobUrl, isLocal: true, type: localBlob.type };
        } else {
            const netUrl = getVideoUrl(name, isUser);
            if (netUrl) result = { src: netUrl, isLocal: false, type: '' };
        }
        mediaCache.set(k, result);
        return result;
    }

    /* ========== 3. 身份识别：角色名 / 是否用户 / 面具唯一 ID ========== */
    const clampVal = (v, min, max) => Math.max(min, Math.min(max, v));

    function getCharName(mes) {
        const attr = mes.getAttribute('ch_name');
        if (attr && attr.trim()) return attr.trim();

        /* .ch_name 里还有时间戳节点，先取 name_text，避免把时间混进存储键 */
        const nameSpan = mes.querySelector('.ch_name .name_text');
        if (nameSpan && nameSpan.textContent.trim()) return nameSpan.textContent.trim();

        const wrap = mes.querySelector('.mesAvatarWrapper')?.getAttribute('ch_name');
        if (wrap) return wrap;

        return mes.querySelector('.ch_name')?.textContent?.trim() || 'default';
    }

    function isUserMessage(mes) {
        return mes.classList.contains('is_user')
            || mes.getAttribute('is_user') === 'true'
            || mes.getAttribute('isUser') === 'true';
    }

    /* 面具（persona）必须用磁盘唯一 ID，不能用显示名——用户存在同名面具。
       来源 1：用户消息头像 src 里的 /thumbnail?type=persona&file=xxx
       来源 2：面具管理面板 .avatar-container.selected 的 data-avatar-id
       兜底 3：上次成功解析到的 ID（页面刚加载、面板还没渲染时也别退成固定值） */
    let personaIdCache = { id: '', ts: 0 };
    const PERSONA_ID_KEY = 'st_avatar_last_persona_id';

    function rememberPersonaId(id) {
        if (!id || id === 'default_persona') return;
        try { localStorage.setItem(PERSONA_ID_KEY, id); } catch (e) { /* ignore */ }
    }

    function storedPersonaId() {
        try { return localStorage.getItem(PERSONA_ID_KEY) || ''; } catch (e) { return ''; }
    }

    function getPersonaId() {
        const now = Date.now();
        if (personaIdCache.id && now - personaIdCache.ts < 1000) return personaIdCache.id;

        let id = '';
        try {
            const mes = document.querySelector('#chat .mes.is_user');
            const img = mes && mes.querySelector('.avatar img');
            if (img && img.src) {
                const u = new URL(img.src, location.origin);
                if (u.searchParams.get('type') === 'persona') {
                    id = decodeURIComponent(u.searchParams.get('file') || '');
                }
            }
        } catch (e) { /* ignore */ }

        if (!id) {
            const sel = document.querySelector('#user_avatar_block .avatar-container.selected');
            id = (sel && sel.getAttribute('data-avatar-id')) || '';
        }

        if (!id) id = storedPersonaId();
        if (id) rememberPersonaId(id);

        /* 解析不到就短缓存，等面板渲染好再来一次，别把空值钉死 */
        personaIdCache = id ? { id, ts: now } : { id: 'default_persona', ts: 0 };
        return id || 'default_persona';
    }

    function invalidatePersonaId() {
        personaIdCache = { id: '', ts: 0 };
    }

    /* 面板入口用：取当前角色的存储名（与消息里的 ch_name 保持一致） */
    function getCharStoreName() {
        const mes = document.querySelector('#chat .mes:not(.is_user)');
        if (mes) {
            const n = getCharName(mes);
            if (n && n !== 'default') return n;
        }
        const ctx = getCtx();
        const ch = ctx.characters ? (ctx.characters[ctx.characterId] || ctx.characters[Number(ctx.characterId)]) : null;
        return (ch && ch.name) || ctx.name2 || 'default';
    }

    function getStoreName(mes) {
        return isUserMessage(mes) ? getPersonaId() : getCharName(mes);
    }

    function findAvatar(mes) {
        const wrapper = mes.querySelector('.mesAvatarWrapper') || mes;
        const av = wrapper.querySelector('.avatar');

        if (av) {
            let el = av.querySelector('img, video');
            if (el) return { el, mode: 'object', container: av };
            if (av.tagName === 'IMG' || av.tagName === 'VIDEO') {
                return { el: av, mode: 'object', container: av.parentElement || av };
            }
            const bg = getComputedStyle(av).backgroundImage;
            if (bg && bg !== 'none') return { el: av, mode: 'background', container: av };
        }
        const el = wrapper.querySelector('img, video');
        if (el) return { el, mode: 'object', container: el.parentElement };
        return null;
    }

    /* ========== 4. 写酒馆原生头像（服务器 API，绕开酒馆自己的裁剪弹窗） ========== */
    function getCtx() {
        try {
            return (window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext()) || {};
        } catch (e) {
            return {};
        }
    }

    /* getRequestHeaders() 默认带 Content-Type: application/json，multipart 必须去掉 */
    function formHeaders() {
        const out = {};
        try {
            const ctx = getCtx();
            const h = (ctx.getRequestHeaders && ctx.getRequestHeaders()) || {};
            Object.keys(h).forEach((k) => {
                if (k.toLowerCase() !== 'content-type') out[k] = h[k];
            });
        } catch (e) { /* ignore */ }
        const tok = document.querySelector('#csrf_token')?.value;
        if (tok && !out['X-CSRF-Token']) out['X-CSRF-Token'] = tok;
        return out;
    }

    function pngFile(blob, fileName) {
        return new File([blob], fileName, { type: 'image/png' });
    }

    function thumbFileOf(src) {
        try {
            const u = new URL(src, location.origin);
            return { type: u.searchParams.get('type'), file: u.searchParams.get('file') };
        } catch (e) {
            return { type: null, file: null };
        }
    }

    /* 上传后必须刷新缩略图缓存，否则浏览器还在用旧图 */
    async function bustAndRefreshAvatar(type, file) {
        const base = `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`;
        try { await fetch(base, { cache: 'reload' }); } catch (e) { /* ignore */ }

        const busted = `${base}&t=${Date.now()}`;
        const apply = (img) => {
            if (!img || img.dataset.avatarCustom === '1') return;   // 自定义叠加层别覆盖
            img.src = busted;
            /* 记忆里"原始头像地址"也要一起更新，否则恢复原生时又用回旧缓存图 */
            const av = img.closest('.avatar');
            if (av && av.dataset.origSrc) av.dataset.origSrc = busted;
        };

        document.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src') || '';
            if (!src || src.indexOf(`type=${type}`) < 0) return;
            const f = thumbFileOf(img.src);
            if (f.type === type && f.file && f.file === file) apply(img);
        });

        if (type === 'avatar') {
            const prev = document.getElementById('avatar_load_preview');
            if (prev) apply(prev);
        }
    }

    /**
     * 把一张 PNG 写进酒馆原生头像。
     * 角色：POST /api/characters/edit-avatar（avatar_url = 角色头像文件名）
     * 面具：POST /api/avatars/upload（overwrite_name = 面具唯一 ID）
     * 都不带 crop 参数 → 服务端按原尺寸保存，不会被压到 768。
     */
    async function writeNativeAvatar(isUser, name, blob) {
        const headers = formHeaders();
        try {
            if (isUser) {
                const personaId = (name && name !== 'default_persona') ? name : getPersonaId();
                if (!personaId || personaId === 'default_persona') return { ok: false, reason: 'no-persona' };

                const fd = new FormData();
                fd.append('avatar', pngFile(blob, 'persona.png'));
                fd.append('overwrite_name', personaId);
                const res = await fetch('/api/avatars/upload', { method: 'POST', headers, body: fd, cache: 'no-cache' });
                if (!res.ok) return { ok: false, reason: `http-${res.status}` };

                /* 服务端可能返回实际落盘文件名，以它为准刷新缩略图 */
                let finalId = personaId;
                try {
                    const data = await res.clone().json();
                    if (data && data.path) finalId = data.path;
                } catch (e) { /* 有的版本无 json */ }

                await bustAndRefreshAvatar('persona', finalId);
                return { ok: true };
            }

            const ctx = getCtx();
            const ch = ctx.characters
                ? (ctx.characters[ctx.characterId] || ctx.characters[Number(ctx.characterId)])
                : null;
            const avatarUrl = ch && ch.avatar;
            if (!avatarUrl || avatarUrl === 'none') return { ok: false, reason: 'no-character' };

            const fd = new FormData();
            fd.append('avatar', pngFile(blob, 'avatar.png'));
            fd.append('avatar_url', avatarUrl);
            const res = await fetch('/api/characters/edit-avatar', { method: 'POST', headers, body: fd, cache: 'no-cache' });
            if (!res.ok) return { ok: false, reason: `http-${res.status}` };

            await bustAndRefreshAvatar('avatar', avatarUrl);
            return { ok: true };
        } catch (e) {
            console.warn('[头像扩展] 原生头像写入异常', e);
            return { ok: false, reason: 'exception' };
        }
    }

    /* 视频取首帧 → 2:3 PNG，用来当原生头像，避免侧栏是旧图 */
    function videoPosterBlob(blob) {
        return new Promise((resolve) => {
            let finished = false;
            const url = URL.createObjectURL(blob);
            const v = document.createElement('video');
            v.muted = true;
            v.playsInline = true;
            v.preload = 'auto';
            v.src = url;
            v.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none';
            document.body.appendChild(v);

            const finish = (res) => {
                if (finished) return;
                finished = true;
                try { v.remove(); } catch (e) { /* ignore */ }
                try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
                resolve(res);
            };

            const grab = () => {
                try {
                    const w = v.videoWidth;
                    const h = v.videoHeight;
                    if (!w || !h) return finish(null);
                    let sw = w;
                    let sh = w * AV_H_PER_W;
                    if (sh > h) { sh = h; sw = h / AV_H_PER_W; }
                    const sx = (w - sw) / 2;
                    const sy = (h - sh) / 2;
                    const outH = Math.max(AV_MIN_H, Math.min(AV_MAX_H, Math.round(sh)));
                    const outW = Math.round(outH / AV_H_PER_W);
                    const c = document.createElement('canvas');
                    c.width = outW;
                    c.height = outH;
                    const g = c.getContext('2d');
                    g.imageSmoothingQuality = 'high';
                    g.drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH);
                    c.toBlob((b) => finish(b), 'image/png');
                } catch (e) {
                    finish(null);
                }
            };

            v.addEventListener('loadeddata', () => {
                try { v.currentTime = 0.08; } catch (e) { /* 有些格式不支持 seek */ }
                grab();
            });
            v.addEventListener('seeked', grab);
            setTimeout(() => finish(null), 5000);
        });
    }

    function toast(msg, isWarn) {
        try {
            const t = window.toastr;
            if (t) {
                if (isWarn && t.warning) t.warning(msg, '头像');
                else if (t.info) t.info(msg, '头像');
                else if (t.success) t.success(msg, '头像');
                return;
            }
        } catch (e) { /* ignore */ }
        console.log('[头像扩展]', msg);
    }

    /* ========== 5. 统一弹窗（Shadow DOM：选择 / 裁剪 两步） ========== */
    let modalHost = null;
    let modalTarget = null;              // { isUser, name, label }
    let pending = null;                   // { kind:'image'|'video', blob, w, h }

    function ensureModal() {
        if (modalHost) return modalHost;

        modalHost = document.createElement('div');
        modalHost.id = 'st-avatar-plus-modal';
        modalHost.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:none;';
        (document.documentElement || document.body).appendChild(modalHost);

        const shadow = modalHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
<style>
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
.overlay {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    padding: 12px; pointer-events: auto;
    background: rgba(0, 0, 0, .74);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    animation: fade .16s ease-out;
}
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
.card {
    width: min(100%, 420px);
    max-height: min(88vh, calc(100dvh - 24px));
    display: flex; flex-direction: column; overflow: hidden;
    background: linear-gradient(180deg, #17171a 0%, #0d0d10 100%);
    border: 1px solid rgba(255, 255, 255, .10);
    border-radius: 20px;
    box-shadow: 0 30px 70px rgba(0, 0, 0, .65), 0 1px 0 rgba(255, 255, 255, .06) inset;
    padding: 16px 16px 14px;
    color: #ededed;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif;
    font-size: 14px;
    animation: rise .2s cubic-bezier(.22,.9,.3,1);
}
@keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.985) } to { opacity: 1; transform: none } }
.content {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding-right: 2px; margin-right: -2px;
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.16) transparent;
}
.content::-webkit-scrollbar { width: 4px; }
.content::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 4px; }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex: 0 0 auto; }
.badge {
    font-size: 11px; line-height: 1; padding: 5px 9px; border-radius: 999px;
    font-weight: 600; letter-spacing: .04em; white-space: nowrap;
    border: 1px solid transparent;
}
.badge--c { background: #f4f4f4; color: #101012; border-color: #f4f4f4; }
.badge--u { background: rgba(255,255,255,.10); color: #e8e8ea; border-color: rgba(255,255,255,.24); }
.badge--n { background: transparent; color: #8d8d92; border-color: rgba(255,255,255,.16); }
.name {
    flex: 1; min-width: 0; font-size: 12.5px; font-weight: 500; color: #a6a6ab;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.iconbtn {
    flex: 0 0 auto; width: 26px; height: 26px; border-radius: 50%; padding: 0;
    border: 1px solid rgba(255,255,255,.12); background: transparent; color: #9a9a9f;
    font-size: 15px; line-height: 1; cursor: pointer; display: flex;
    align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent;
    transition: background .15s ease, color .15s ease, border-color .15s ease;
}
.iconbtn:hover { background: rgba(255,255,255,.08); color: #fff; border-color: rgba(255,255,255,.26); }
.picker {
    width: 100%; display: flex; align-items: center; gap: 12px;
    padding: 15px 14px; border-radius: 14px; cursor: pointer;
    border: 1px dashed rgba(255,255,255,.26);
    background: rgba(255,255,255,.045);
    color: #f2f2f3; text-align: left; font: inherit;
    -webkit-tap-highlight-color: transparent;
    transition: background .15s ease, border-color .15s ease;
}
.picker:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.42); }
.picker:active { transform: scale(.995); }
.picker svg { flex: 0 0 auto; width: 20px; height: 20px; stroke: #f2f2f3; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.picker-txt { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.picker-t { font-size: 14px; font-weight: 600; color: #f4f4f5; letter-spacing: .01em; }
.picker-s { font-size: 11.5px; color: #86868b; line-height: 1.4; }
.or { display: flex; align-items: center; gap: 10px; margin: 15px 0 11px; }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: rgba(255,255,255,.09); }
.or span { font-size: 11px; color: #6f6f74; letter-spacing: .06em; }
.url {
    width: 100%; padding: 12px 13px; border-radius: 12px;
    border: 1px solid rgba(255,255,255,.13); background: rgba(255,255,255,.045);
    color: #f2f2f3; font: inherit; outline: none;
    transition: border-color .15s ease, background .15s ease;
}
.url::placeholder { color: #6a6a6f; }
.url:focus { border-color: rgba(255,255,255,.42); background: rgba(255,255,255,.07); }
.state {
    margin-top: 12px; font-size: 11.5px; color: #86868b;
    display: flex; align-items: center; gap: 7px;
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: #5a5a5f; flex: 0 0 auto; }
.dot--on { background: #f2f2f3; box-shadow: 0 0 10px rgba(255,255,255,.45); }
.hint { margin-top: 13px; font-size: 11.5px; line-height: 1.7; color: #75757a; }
.chip {
    margin-top: 12px; display: none; align-items: center; gap: 9px;
    padding: 9px 11px; border-radius: 11px;
    background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15);
    color: #eaeaec; font-size: 12px;
}
.chip .ok { font-size: 12px; color: #fff; }
.foot {
    flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px;
    margin-top: 14px; padding-top: 13px;
    border-top: 1px solid rgba(255,255,255,.07);
}
.footrow { display: flex; gap: 8px; }
button {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    border: 1px solid transparent; border-radius: 12px; padding: 11px 14px;
    color: #ededee; background: transparent;
    -webkit-tap-highlight-color: transparent; white-space: nowrap;
    transition: background .15s ease, opacity .15s ease, color .15s ease;
}
button:active { opacity: .78; }
.primary {
    width: 100%; background: #f7f7f8; color: #101012; border-color: #f7f7f8;
    box-shadow: 0 8px 22px rgba(0, 0, 0, .45);
}
.primary:hover { background: #fff; }
.cancel { flex: 1 1 0; background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.10); color: #b6b6ba; padding: 10px 8px; }
.cancel:hover { background: rgba(255,255,255,.10); }
.ghost  { flex: 1 1 0; background: transparent; border-color: rgba(255,255,255,.14); color: #9c9ca1; font-weight: 500; padding: 10px 8px; }
.ghost:hover { background: rgba(255,255,255,.06); color: #e6e6e8; }
.subrow { display: flex; justify-content: center; margin-top: 10px; }
.linkbtn {
    border: none; background: none; color: #75757a; font: inherit; font-size: 11.5px;
    cursor: pointer; padding: 4px; text-decoration: underline; text-underline-offset: 3px;
    -webkit-tap-highlight-color: transparent;
}
.linkbtn:hover { color: #a8a8ad; }
/* 裁剪页 */
.cropcard { padding: 16px; }
.cropwrap {
    position: relative; width: 100%; border-radius: 14px; overflow: hidden;
    background: #0a0a0b; border: 1px solid rgba(255,255,255,.08);
}
.stage { position: relative; width: 100%; height: min(44vh, 380px); touch-action: none; }
.stage img {
    position: absolute; user-select: none; -webkit-user-drag: none; pointer-events: none;
    image-rendering: auto;
}
.sel {
    position: absolute; border: 1px solid rgba(255,255,255,.92);
    box-shadow: 0 0 0 9999px rgba(0,0,0,.66);
    cursor: move;
}
.sel::after {
    content: ""; position: absolute; inset: 0;
    background:
        linear-gradient(to right, rgba(255,255,255,.30) 1px, transparent 1px) 0 0 / 33.333% 100%,
        linear-gradient(to bottom, rgba(255,255,255,.30) 1px, transparent 1px) 0 0 / 100% 33.333%;
    opacity: .9; pointer-events: none;
}
.handle {
    position: absolute; width: 16px; height: 16px; border-radius: 4px;
    background: #fff; border: 1px solid rgba(0,0,0,.45);
    box-shadow: 0 2px 8px rgba(0,0,0,.5);
}
.handle[data-h="nw"] { left: -8px; top: -8px; cursor: nwse-resize; }
.handle[data-h="ne"] { right: -8px; top: -8px; cursor: nesw-resize; }
.handle[data-h="sw"] { left: -8px; bottom: -8px; cursor: nesw-resize; }
.handle[data-h="se"] { right: -8px; bottom: -8px; cursor: nwse-resize; }
</style>
<div class="overlay">
  <div class="card" id="pickPage">
    <div class="head">
      <span class="badge" id="roleBadge">角色</span>
      <span class="name" id="nameText"></span>
      <button class="iconbtn" id="closePick" title="关闭">&times;</button>
    </div>

    <div class="content">
      <button class="picker" id="fileBtn" type="button">
        <svg viewBox="0 0 24 24"><path d="M12 15V3m0 0L8 7m4-4l4 4"/><path d="M3 15v3a2 2 0 002 2h14a2 2 0 002-2v-3"/></svg>
        <span class="picker-txt">
          <span class="picker-t">选择本机图片或视频</span>
          <span class="picker-s">图片自动裁成 2:3 写入原生头像 · 视频作为动态头像</span>
        </span>
      </button>
      <input id="fileInput" type="file" accept="image/*,video/*" style="display:none">

      <div class="or"><span>或粘贴链接</span></div>
      <input class="url" id="urlInput" type="url" inputmode="url" autocapitalize="off"
             autocorrect="off" spellcheck="false" placeholder="https://… 图片或视频直链">

      <div class="state"><span class="dot" id="stateDot"></span><span id="stateText">酒馆原生头像</span></div>
      <div class="chip" id="chip"><span class="ok">✓</span><span id="chipText"></span></div>

      <div class="hint">
        图片写入原生头像后，侧栏、角色列表、手机端与聊天头像同步，不再有两套图；<br>
        位置与缩放按「存档 + 角色/面具」独立保存，新楼层一出现就是调节后的位置。
      </div>
    </div>

    <div class="foot">
      <div class="footrow">
        <button class="ghost" id="nativeBtn" type="button">恢复原生</button>
        <button class="ghost" id="resetBtn" type="button">重置位置</button>
        <button class="cancel" id="cancelBtn" type="button">取消</button>
      </div>
      <button class="primary" id="okBtn" type="button">应用</button>
    </div>
  </div>

  <div class="card cropcard" id="cropPage" style="display:none">
    <div class="head">
      <span class="badge badge--n">裁剪</span>
      <span class="name">2:3 头像 · 拖动框选保留区域</span>
      <button class="iconbtn" id="closeCrop" title="关闭">&times;</button>
    </div>
    <div class="content">
      <div class="cropwrap">
        <div class="stage" id="stage">
          <img id="cropImg" alt="" draggable="false">
          <div class="sel" id="sel">
            <div class="handle" data-h="nw"></div>
            <div class="handle" data-h="ne"></div>
            <div class="handle" data-h="sw"></div>
            <div class="handle" data-h="se"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="foot">
      <div class="footrow">
        <button class="ghost" id="backBtn" type="button">返回</button>
        <button class="ghost" id="cropReset" type="button">重置选区</button>
      </div>
      <button class="primary" id="cropOk" type="button">确认裁剪</button>
    </div>
  </div>
</div>`;

        /* ---- 元素引用 ---- */
        const $ = (id) => shadow.getElementById(id);
        const overlay = shadow.querySelector('.overlay');
        const pickPage = $('pickPage');
        const cropPage = $('cropPage');
        const fileInput = $('fileInput');
        const urlInput = $('urlInput');
        const chip = $('chip');
        const chipText = $('chipText');
        const stateDot = $('stateDot');
        const stateText = $('stateText');

        /* ---- 裁剪状态 ---- */
        const crop = {
            img: $('cropImg'),
            stage: $('stage'),
            sel: $('sel'),
            nat: { w: 0, h: 0 },
            box: { x: 0, y: 0, w: 0, h: 0 },
            r: { x: 0, y: 0, w: 0, h: 0 },
            min: 48,
            mode: null,
            start: null,
            srcUrl: '',
        };

        function closeAll() {
            modalHost.style.display = 'none';
            pickPage.style.display = '';
            cropPage.style.display = 'none';
            urlInput.value = '';
            fileInput.value = '';
            chip.style.display = 'none';
            if (crop.srcUrl) {
                try { URL.revokeObjectURL(crop.srcUrl); } catch (e) { /* ignore */ }
                crop.srcUrl = '';
            }
            crop.nat = { w: 0, h: 0 };
            pending = null;
        }

        /* ---- 状态提示（由 openAvatarModal 统一刷新） ---- */
        function showPick() {
            pickPage.style.display = '';
            cropPage.style.display = 'none';
        }

        /* ---- 裁剪：布局 ---- */
        function layoutCrop() {
            if (!crop.nat.w || !crop.nat.h) return;
            const st = crop.stage.getBoundingClientRect();
            const W = st.width || 320;
            const H = st.height || 420;
            const ratio = crop.nat.w / crop.nat.h;

            let dw = W;
            let dh = W / ratio;
            if (dh > H) { dh = H; dw = H * ratio; }
            const dx = (W - dw) / 2;
            const dy = (H - dh) / 2;

            crop.box = { x: dx, y: dy, w: dw, h: dh };
            crop.img.style.left = `${dx}px`;
            crop.img.style.top = `${dy}px`;
            crop.img.style.width = `${dw}px`;
            crop.img.style.height = `${dh}px`;

            /* 默认选区：2:3、占画面 88%，居中 */
            let sw = Math.min(dw * 0.88, dh / AV_H_PER_W * 0.88);
            let sh = sw * AV_H_PER_W;
            crop.r = {
                x: dx + (dw - sw) / 2,
                y: dy + (dh - sh) / 2,
                w: sw,
                h: sh,
            };
            paintSel();
        }

        function paintSel() {
            crop.sel.style.left = `${crop.r.x}px`;
            crop.sel.style.top = `${crop.r.y}px`;
            crop.sel.style.width = `${crop.r.w}px`;
            crop.sel.style.height = `${crop.r.h}px`;
        }

        function stagePoint(e) {
            const st = crop.stage.getBoundingClientRect();
            return { x: e.clientX - st.left, y: e.clientY - st.top };
        }

        const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

        crop.stage.addEventListener('pointerdown', (e) => {
            if (cropPage.style.display === 'none') return;
            const handle = e.target.closest ? e.target.closest('[data-h]') : null;
            const p = stagePoint(e);

            if (handle) {
                crop.mode = handle.getAttribute('data-h');
            } else if (inRect(p, crop.r)) {
                crop.mode = 'move';
            } else {
                return;   // 框外点击不响应，避免误拖整图
            }

            crop.start = { p, r: { ...crop.r } };
            try { crop.stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            e.preventDefault();
        });

        crop.stage.addEventListener('pointermove', (e) => {
            if (!crop.mode || !crop.start) return;
            const p = stagePoint(e);
            const dx = p.x - crop.start.p.x;
            const dy = p.y - crop.start.p.y;
            const b = crop.box;
            const s = crop.start.r;

            if (crop.mode === 'move') {
                let nx = clampVal(s.x + dx, b.x, b.x + b.w - s.w);
                let ny = clampVal(s.y + dy, b.y, b.y + b.h - s.h);
                crop.r = { x: nx, y: ny, w: s.w, h: s.h };
                paintSel();
                return;
            }

            /* 四角缩放：对角固定，保持 2:3 */
            const dirW = crop.mode.indexOf('w') >= 0;
            const dirN = crop.mode.indexOf('n') >= 0;
            const ax = dirW ? s.x + s.w : s.x;          // 锚点
            const ay = dirN ? s.y + s.h : s.y;

            let w = Math.abs(p.x - ax);
            const availW = dirW ? (ax - b.x) : (b.x + b.w - ax);
            const availH = dirN ? (ay - b.y) : (b.y + b.h - ay);
            w = Math.min(w, availW, availH / AV_H_PER_W);
            w = Math.max(crop.min, Math.min(w, b.w, b.h / AV_H_PER_W));

            const h = w * AV_H_PER_W;
            const nx = dirW ? ax - w : ax;
            const ny = dirN ? ay - h : ay;
            crop.r = { x: nx, y: ny, w, h };
            paintSel();
        });

        const endCropDrag = () => {
            crop.mode = null;
            crop.start = null;
        };
        crop.stage.addEventListener('pointerup', endCropDrag);
        crop.stage.addEventListener('pointercancel', endCropDrag);

        function loadCropImage(blob) {
            return new Promise((resolve) => {
                if (crop.srcUrl) {
                    try { URL.revokeObjectURL(crop.srcUrl); } catch (e) { /* ignore */ }
                }
                crop.srcUrl = URL.createObjectURL(blob);
                crop.img.onload = () => {
                    crop.nat = { w: crop.img.naturalWidth || 1, h: crop.img.naturalHeight || 1 };
                    showCropPage();
                    /* 等一帧让 stage 拿到真实尺寸 */
                    requestAnimationFrame(() => requestAnimationFrame(() => layoutCrop()));
                    resolve(true);
                };
                crop.img.onerror = () => resolve(false);
                crop.img.src = crop.srcUrl;
            });
        }

        function showCropPage() {
            pickPage.style.display = 'none';
            cropPage.style.display = '';
        }

        /* 按选区导出 2:3 PNG（不放大，源像素取整避免亚像素发虚） */
        function exportCrop() {
            return new Promise((resolve) => {
                const b = crop.box;
                const r = crop.r;
                if (!b.w || !b.h) return resolve(null);

                const sxF = (r.x - b.x) / b.w * crop.nat.w;
                const syF = (r.y - b.y) / b.h * crop.nat.h;
                const swF = r.w / b.w * crop.nat.w;
                const shF = r.h / b.h * crop.nat.h;

                let sx = Math.max(0, Math.round(sxF));
                let sy = Math.max(0, Math.round(syF));
                let sw = Math.max(1, Math.round(swF));
                let sh = Math.max(1, Math.round(shF));
                if (sx + sw > crop.nat.w) sw = crop.nat.w - sx;
                if (sy + sh > crop.nat.h) sh = crop.nat.h - sy;

                const outH = Math.max(AV_MIN_H, Math.min(AV_MAX_H, sh));
                const outW = Math.round(outH / AV_H_PER_W);

                const c = document.createElement('canvas');
                c.width = outW;
                c.height = outH;
                const g = c.getContext('2d');
                g.imageSmoothingEnabled = true;
                g.imageSmoothingQuality = 'high';
                try {
                    g.drawImage(crop.img, sx, sy, sw, sh, 0, 0, outW, outH);
                } catch (e) {
                    return resolve(null);
                }
                c.toBlob((blob) => resolve(blob ? { blob, w: outW, h: outH } : null), 'image/png');
            });
        }

        /* ---- 选择文件 ---- */
        $('fileBtn').addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', async () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            if (!file) return;
            urlInput.value = '';

            if (/^video\//i.test(file.type)) {
                pending = { kind: 'video', blob: file };
                chip.style.display = 'flex';
                chipText.textContent = `已选择视频：${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB（点"应用"生效）`;
                showPick();
                return;
            }
            if (!/^image\//i.test(file.type)) {
                toast('这个文件类型不支持，请选图片或视频', true);
                return;
            }
            if (!(await loadCropImage(file))) {
                toast('图片读取失败，换一张试试', true);
                showPick();
            }
        });

        /* ---- 裁剪页按钮 ---- */
        $('cropReset').addEventListener('click', () => {
            layoutCrop();
        });
        $('backBtn').addEventListener('click', () => {
            showPick();
        });
        $('closeCrop').addEventListener('click', () => {
            showPick();
        });
        $('cropOk').addEventListener('click', async () => {
            const res = await exportCrop();
            if (!res) {
                toast('裁剪失败，请重试', true);
                return;
            }
            pending = { kind: 'image', blob: res.blob, w: res.w, h: res.h };
            chip.style.display = 'flex';
            chipText.textContent = `已裁剪 ${res.w}×${res.h} · 点"应用"写入原生头像`;
            showPick();
        });

        /* ---- 关闭 / 取消 ---- */
        $('closePick').addEventListener('click', closeAll);
        $('cancelBtn').addEventListener('click', closeAll);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeAll();
        });
        shadow.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeAll();
        });

        /* ---- 恢复原生：清掉自定义媒体，保留位置与缩放 ---- */
        $('nativeBtn').addEventListener('click', async () => {
            if (!modalTarget) return;
            const k = makeKey(modalTarget.name, modalTarget.isUser);
            await deleteLocalFile(k);
            setVideoUrl(modalTarget.name, '', modalTarget.isUser);
            if (activeBlobUrls.has(k)) {
                try { URL.revokeObjectURL(activeBlobUrls.get(k)); } catch (e) { /* ignore */ }
                activeBlobUrls.delete(k);
            }
            clearAllCaches();
            initAll();
            toast('已恢复酒馆原生头像');
            closeAll();
        });

        /* ---- 重置位置与缩放：只清位置，不动头像 ---- */
        $('resetBtn').addEventListener('click', () => {
            if (!modalTarget) return;
            setPos(modalTarget.name, 0, 0, modalTarget.isUser);
            setScale(modalTarget.name, MIN_SCALE, modalTarget.isUser);
            clearAllCaches();
            initAll();
            toast('已重置位置与缩放');
            closeAll();
        });

        /* ---- 应用 ---- */
        $('okBtn').addEventListener('click', async () => {
            if (!modalTarget) return;
            const t = modalTarget;
            const k = makeKey(t.name, t.isUser);
            const url = urlInput.value.trim();

            if (pending && pending.kind === 'image') {
                /* 同一张裁剪图：一份写原生头像，一份存本地做高清显示源 */
                await saveLocalFile(k, pending.blob);
                setVideoUrl(t.name, '', t.isUser);
                const native = await writeNativeAvatar(t.isUser, t.name, pending.blob);
                if (!native.ok) {
                    toast('原生头像写入失败，已保存到当前聊天（' + (native.reason || '未知原因') + '）', true);
                } else {
                    toast('已写入原生头像 · 高清显示');
                }
                clearAllCaches();
                initAll();
                closeAll();
                return;
            }

            if (pending && pending.kind === 'video') {
                await saveLocalFile(k, pending.blob);
                setVideoUrl(t.name, '', t.isUser);
                clearAllCaches();
                initAll();
                const poster = await videoPosterBlob(pending.blob);
                if (poster) {
                    await writeNativeAvatar(t.isUser, t.name, poster);
                }
                toast('已设为动态头像');
                closeAll();
                return;
            }

            if (url) {
                urlInput.value = '';
                if (/^(data:video\/|\S+\.(mp4|webm|mov)(\?|#|$))/i.test(url)) {
                    await deleteLocalFile(k);
                    setVideoUrl(t.name, url, t.isUser);
                    if (activeBlobUrls.has(k)) {
                        try { URL.revokeObjectURL(activeBlobUrls.get(k)); } catch (e) { /* ignore */ }
                        activeBlobUrls.delete(k);
                    }
                    clearAllCaches();
                    initAll();
                    toast('已设为动态头像（链接）');
                    closeAll();
                    return;
                }

                /* 图片直链：尽力抓成 blob 写原生；跨域被拦就退回叠加 */
                try {
                    const resp = await fetch(url, { mode: 'cors' });
                    if (!resp.ok) throw new Error('http ' + resp.status);
                    const raw = await resp.blob();
                    if (!/^image\//i.test(raw.type)) throw new Error('not image');
                    const png = await loadCropImageQuiet(raw);
                    if (!png) throw new Error('decode');
                    await saveLocalFile(k, png);
                    setVideoUrl(t.name, '', t.isUser);
                    const native = await writeNativeAvatar(t.isUser, t.name, png);
                    clearAllCaches();
                    initAll();
                    toast(native.ok ? '已写入原生头像' : '已设为当前聊天头像（原生写入失败）', !native.ok);
                } catch (e) {
                    await deleteLocalFile(k);
                    setVideoUrl(t.name, url, t.isUser);
                    if (activeBlobUrls.has(k)) {
                        try { URL.revokeObjectURL(activeBlobUrls.get(k)); } catch (err) { /* ignore */ }
                        activeBlobUrls.delete(k);
                    }
                    clearAllCaches();
                    initAll();
                    toast('已设为当前聊天头像（跨域无法写原生）', true);
                }
                closeAll();
                return;
            }

            toast('先选一个文件，或粘贴链接', true);
        });

        /* 链接图片先居中裁成 2:3，再走写原生流程 */
        function loadCropImageQuiet(blob) {
            return new Promise((resolve) => {
                const u = URL.createObjectURL(blob);
                const im = new Image();
                im.onload = () => {
                    try {
                        const w = im.naturalWidth;
                        const h = im.naturalHeight;
                        let sw = w;
                        let sh = w * AV_H_PER_W;
                        if (sh > h) { sh = h; sw = h / AV_H_PER_W; }
                        const sx = (w - sw) / 2;
                        const sy = (h - sh) / 2;
                        const outH = Math.max(AV_MIN_H, Math.min(AV_MAX_H, Math.round(sh)));
                        const outW = Math.round(outH / AV_H_PER_W);
                        const c = document.createElement('canvas');
                        c.width = outW;
                        c.height = outH;
                        const g = c.getContext('2d');
                        g.imageSmoothingQuality = 'high';
                        g.drawImage(im, sx, sy, sw, sh, 0, 0, outW, outH);
                        c.toBlob((b) => {
                            try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
                            resolve(b);
                        }, 'image/png');
                    } catch (e) {
                        resolve(null);
                    }
                };
                im.onerror = () => {
                    try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
                    resolve(null);
                };
                im.src = u;
            });
        }

        /* 面板尺寸变化时重算裁剪布局 */
        window.addEventListener('resize', () => {
            if (modalHost.style.display !== 'none' && cropPage.style.display !== 'none') {
                layoutCrop();
            }
        });

        return modalHost;
    }

    async function openAvatarModal(target) {
        ensureModal();
        const shadow = modalHost.shadowRoot;
        const $ = (id) => shadow.getElementById(id);

        modalTarget = {
            isUser: !!target.isUser,
            name: target.name || (target.isUser ? getPersonaId() : getCharStoreName()),
            label: target.label || (target.isUser ? '面具' : '角色'),
        };
        pending = null;

        const badge = $('roleBadge');
        badge.className = `badge ${modalTarget.isUser ? 'badge--u' : 'badge--c'}`;
        badge.textContent = modalTarget.label;
        $('nameText').textContent = modalTarget.name === 'default_persona' ? '默认面具' : modalTarget.name;

        $('pickPage').style.display = '';
        $('cropPage').style.display = 'none';
        $('urlInput').value = '';
        $('chip').style.display = 'none';

        modalHost.style.display = 'block';
        await refreshModalState();

        /* 页面刚启动时面具面板可能还没渲染：稍等再解析一次唯一 ID */
        if (modalTarget.isUser && modalTarget.name === 'default_persona') {
            setTimeout(() => {
                if (!modalTarget || !modalTarget.isUser) return;
                const real = getPersonaId();
                if (real && real !== 'default_persona') {
                    modalTarget.name = real;
                    $('nameText').textContent = real;
                    refreshModalState();
                }
            }, 450);
        }
    }

    async function refreshModalState() {
        if (!modalHost || !modalTarget) return;
        const shadow = modalHost.shadowRoot;
        const dot = shadow.getElementById('stateDot');
        const txt = shadow.getElementById('stateText');
        const k = makeKey(modalTarget.name, modalTarget.isUser);
        const local = await getLocalFile(k, null);
        const net = getVideoUrl(modalTarget.name, modalTarget.isUser);
        if (local) {
            dot.className = 'dot dot--on';
            txt.textContent = `当前：本地文件 ${(local.size / (1024 * 1024)).toFixed(1)} MB`;
        } else if (net) {
            dot.className = 'dot dot--on';
            txt.textContent = '当前：网络链接';
        } else {
            dot.className = 'dot';
            txt.textContent = '当前：酒馆原生头像';
        }
    }

    /* ========== 6. 核心：自适应画幅物理覆盖与锁边位移引擎 ========== */
    let unlockedEl = null;

    function lockAvatarEdit() {
        if (unlockedEl && typeof unlockedEl.__lockAvatar === 'function') {
            unlockedEl.__lockAvatar();
        }
        unlockedEl = null;
    }

    function bindUnlockGuards() {
        document.addEventListener('pointerdown', (e) => {
            if (!unlockedEl) return;
            if (e.target === unlockedEl || unlockedEl.contains(e.target)) return;
            lockAvatarEdit();
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !unlockedEl) return;
            if (modalHost && modalHost.style.display !== 'none') return;
            lockAvatarEdit();
        });
    }

    function setupDrag(target, storeName, isUser) {
        const el = target.el;
        const mode = target.mode;
        const container = target.container;
        if (!el || !container) return;

        container.style.overflow = 'hidden';
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        let nameNow = storeName;
        let isUserNow = !!isUser;
        let pos = getPos(nameNow, isUserNow);
        let scale = Math.max(MIN_SCALE, getScale(nameNow, isUserNow));
        let raf = 0;
        let lastBox = null;   // 容器在流内的原始尺寸，用于 absolute 之后兜底

        const getMediaIntrinsicSize = () => {
            if (mode === 'background') return null;
            if (el.tagName === 'VIDEO') return { w: el.videoWidth || 0, h: el.videoHeight || 0 };
            return { w: el.naturalWidth || 0, h: el.naturalHeight || 0 };
        };

        const getRenderDimensions = (boxW, boxH) => {
            const intrinsic = getMediaIntrinsicSize();
            let renderW = boxW;
            let renderH = boxH;
            if (intrinsic && intrinsic.w > 0 && intrinsic.h > 0) {
                const boxRatio = boxW / boxH;
                const mediaRatio = intrinsic.w / intrinsic.h;
                if (mediaRatio > boxRatio) {
                    renderH = boxH;
                    renderW = boxH * mediaRatio;
                } else {
                    renderW = boxW;
                    renderH = boxW / mediaRatio;
                }
            }
            return { renderW, renderH };
        };

        const readBox = () => {
            const rect = container.getBoundingClientRect();
            let w = rect.width;
            let h = rect.height;
            if (w > 2 && h > 2) {
                lastBox = { w, h };
                return lastBox;
            }
            w = container.offsetWidth;
            h = container.offsetHeight;
            if (w > 2 && h > 2) {
                lastBox = { w, h };
                return lastBox;
            }
            return null;
        };

        const clampSafePosition = (x, y, s, box) => {
            const { renderW, renderH } = getRenderDimensions(box.w, box.h);
            const totalW = renderW * s;
            const totalH = renderH * s;
            const maxX = Math.max(0, (totalW - box.w) / 2);
            const maxY = Math.max(0, (totalH - box.h) / 2);
            return {
                x: clampVal(x, -maxX, maxX),
                y: clampVal(y, -maxY, maxY),
            };
        };

        /**
         * fromRestore = true 时不重新 clamp。
         * 新插入的楼层图片还没解码，容器可能量不到尺寸，此时 clamp 会把
         * 已保存的位移错误归零 —— 这就是"位置自己回到原处"的真凶。
         */
        const applyTransform = (x, y, s, fromRestore) => {
            let box = readBox();
            if (!box) {
                /* 容器还没量到尺寸（新楼层刚插入那一瞬）：
                   至少先把位移摆到用户存的位置，别让人先看到"原位置"那一下；
                   宽度/高度等下一次 load / rAF 再补齐。 */
                if (mode !== 'background') {
                    const ox = Math.round(x);
                    const oy = Math.round(y);
                    el.style.position = 'absolute';
                    el.style.left = '50%';
                    el.style.top = '50%';
                    el.style.transformOrigin = 'center center';
                    el.style.transform = `translate3d(calc(-50% + ${ox}px), calc(-50% + ${oy}px), 0px)`;
                }
                return;
            }

            let px = x;
            let py = y;
            if (!fromRestore) {
                const safe = clampSafePosition(x, y, s, box);
                px = safe.x;
                py = safe.y;
            }

            pos.x = px;
            pos.y = py;
            scale = s;

            if (mode === 'background') {
                el.style.backgroundSize = `${s * 100}% auto`;
                el.style.backgroundPosition = `calc(50% + ${px}px) calc(50% + ${py}px)`;
                return;
            }

            /* 放大不用 transform: scale()：那是把已栅格化的位图再拉伸。
               直接按"渲染尺寸 × 缩放"算整数像素宽高，浏览器每次按最终尺寸重采样原图。 */
            const { renderW, renderH } = getRenderDimensions(box.w, box.h);
            const drawW = Math.max(1, Math.round(renderW * s));
            const drawH = Math.max(1, Math.round(renderH * s));
            const offX = Math.round(px);
            const offY = Math.round(py);

            el.style.position = 'absolute';
            el.style.left = '50%';
            el.style.top = '50%';
            el.style.width = `${drawW}px`;
            el.style.height = `${drawH}px`;
            el.style.minWidth = `${drawW}px`;
            el.style.minHeight = `${drawH}px`;
            el.style.maxWidth = 'none';
            el.style.maxHeight = 'none';
            el.style.objectFit = 'cover';
            el.style.objectPosition = 'center center';
            el.style.display = 'block';
            el.style.transformOrigin = 'center center';
            el.style.transform = `translate3d(calc(-50% + ${offX}px), calc(-50% + ${offY}px), 0px)`;
        };

        el.__applyStoredTransform = () => {
            pos = getPos(nameNow, isUserNow);
            scale = clampVal(getScale(nameNow, isUserNow) || 1, MIN_SCALE, MAX_SCALE);
            applyTransform(pos.x, pos.y, scale, true);   // ★ 恢复存档不 clamp
        };

        el.__setChar = (name, isUserFlag) => {
            nameNow = name;
            if (typeof isUserFlag === 'boolean') isUserNow = isUserFlag;
            el.__applyStoredTransform();
        };

        if (el.dataset.dragReady) return;
        el.dataset.dragReady = '1';

        let pending = null;

        /* 一帧只重绘一次，但坐标永远记最新的那份：
           同一帧里连发的多次移动不能被忽略，否则松手时最后一段位移会丢，
           看起来就像"拖过去了又弹回一点"。 */
        const schedule = (x, y, s) => {
            pending = { x, y, s };
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                const p = pending;
                pending = null;
                if (p) applyTransform(p.x, p.y, p.s, false);
            });
        };

        /* 松手/结束前把最后一帧的位移补上，保证存的正是用户看到的那个位置 */
        const flushPending = () => {
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            if (pending) {
                const p = pending;
                pending = null;
                applyTransform(p.x, p.y, p.s, false);
            }
        };

        const reapply = () => {
            try {
                el.__applyStoredTransform();
                /* 两次补帧：图片解码/容器布局可能晚一帧才稳 */
                requestAnimationFrame(() => {
                    try { el.__applyStoredTransform(); } catch (e) { /* 元素已移除 */ }
                });
            } catch (e) { /* 元素已移除 */ }
        };

        if (el.tagName === 'IMG') {
            el.addEventListener('load', reapply);
            el.addEventListener('error', reapply);
        } else if (el.tagName === 'VIDEO') {
            el.addEventListener('loadedmetadata', reapply);
            el.addEventListener('loadeddata', reapply);
        }

        el.__applyStoredTransform();
        /* 图片已经解码完成时 load 不会再触发，这里主动补一次 */
        if (el.tagName === 'IMG' && el.complete) requestAnimationFrame(reapply);

        /* ---------- 交互锁：默认锁定，双击才进入编辑模式 ---------- */
        const DBL_TAP_MS = 320;
        const DRAG_THRESHOLD = 5;
        const TAP_SLOP = 10;

        let unlocked = false;
        let lastTapT = 0;
        let lockedStart = null;
        let lastTouchEndT = 0;

        el.style.userSelect = 'none';
        el.style.webkitUserDrag = 'none';

        const setUnlocked = (v) => {
            if (unlocked === v) return;
            unlocked = v;
            if (v) {
                if (unlockedEl && unlockedEl !== el) unlockedEl.__lockAvatar?.();
                unlockedEl = el;
                el.style.outline = '2px solid rgba(255,255,255,.92)';
                el.style.outlineOffset = '-2px';
                el.style.cursor = 'grab';
                if (mode !== 'background') el.style.touchAction = 'none';
            } else {
                if (unlockedEl === el) unlockedEl = null;
                el.style.outline = '';
                el.style.outlineOffset = '';
                el.style.cursor = '';
                el.style.touchAction = '';
            }
        };

        el.__lockAvatar = () => setUnlocked(false);

        const registerTap = () => {
            const now = Date.now();
            if (now - lastTapT < DBL_TAP_MS) {
                lastTapT = 0;
                setUnlocked(!unlocked);
            } else {
                lastTapT = now;
            }
        };

        /* 桌面滚轮缩放（仅编辑模式） */
        el.addEventListener('wheel', (e) => {
            if (!unlocked) return;
            e.preventDefault();
            e.stopPropagation();
            const step = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
            const newScale = clampVal(Math.round((scale + step) * 100) / 100, MIN_SCALE, MAX_SCALE);
            schedule(pos.x, pos.y, newScale);
            setScale(nameNow, newScale, isUserNow);
        }, { passive: false });

        /* 桌面鼠标平移 */
        let mDrag = false;
        let mLastX = 0;
        let mLastY = 0;

        const mMove = (e) => {
            if (!mDrag) return;
            const dx = e.clientX - mLastX;
            const dy = e.clientY - mLastY;
            mLastX = e.clientX;
            mLastY = e.clientY;
            pos.x += dx;
            pos.y += dy;
            schedule(pos.x, pos.y, scale);
        };

        const mUp = () => {
            document.removeEventListener('mousemove', mMove);
            document.removeEventListener('mouseup', mUp);
            if (!mDrag) return;
            mDrag = false;
            el.style.cursor = unlocked ? 'grab' : '';
            flushPending();
            const box = readBox();
            if (box) {
                const safe = clampSafePosition(pos.x, pos.y, scale, box);
                applyTransform(safe.x, safe.y, scale, false);
                setPos(nameNow, safe.x, safe.y, isUserNow);
            }
        };

        el.addEventListener('mousedown', (e) => {
            if (!unlocked || e.button !== 0) return;
            mDrag = true;
            mLastX = e.clientX;
            mLastY = e.clientY;
            el.style.cursor = 'grabbing';
            e.preventDefault();
            e.stopPropagation();
            document.addEventListener('mousemove', mMove);
            document.addEventListener('mouseup', mUp);
        });

        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (Date.now() - lastTouchEndT < 800) return;
            setUnlocked(!unlocked);
        });

        /* 移动端 */
        let tActive = false;
        let tDrag = false;
        let tPinch = false;
        let tConsumed = false;
        let tStartX = 0;
        let tStartY = 0;
        let tLastX = 0;
        let tLastY = 0;
        let pinchStartDist = 0;
        let pinchStartScale = 1;

        const getTouchDist = (touches) => Math.hypot(
            touches[0].clientX - touches[1].clientX,
            touches[0].clientY - touches[1].clientY,
        );

        const tStart = (e) => {
            if (!unlocked) {
                lockedStart = e.touches.length === 1
                    ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
                    : null;
                return;
            }
            if (e.touches.length === 2) {
                tPinch = true;
                tDrag = false;
                tActive = true;
                pinchStartDist = getTouchDist(e.touches);
                pinchStartScale = scale;
                return;
            }
            if (e.touches.length === 1) {
                const t = e.touches[0];
                tStartX = t.clientX;
                tStartY = t.clientY;
                tLastX = t.clientX;
                tLastY = t.clientY;
                tActive = true;
                tDrag = false;
                tPinch = false;
                tConsumed = false;
            }
        };

        const tMove = (e) => {
            if (!unlocked || !tActive) return;

            if (e.touches.length === 2) {
                e.preventDefault();
                const dist = getTouchDist(e.touches);
                if (pinchStartDist > 0) {
                    const factor = dist / pinchStartDist;
                    const newScale = clampVal(
                        Math.round(pinchStartScale * factor * 100) / 100,
                        MIN_SCALE,
                        MAX_SCALE,
                    );
                    schedule(pos.x, pos.y, newScale);
                }
                return;
            }

            if (tConsumed || tPinch || e.touches.length !== 1) return;
            const t = e.touches[0];

            if (!tDrag) {
                if (Math.hypot(t.clientX - tStartX, t.clientY - tStartY) > DRAG_THRESHOLD) {
                    tDrag = true;
                    el.style.cursor = 'grabbing';
                } else {
                    return;
                }
            }

            e.preventDefault();
            const dx = t.clientX - tLastX;
            const dy = t.clientY - tLastY;
            tLastX = t.clientX;
            tLastY = t.clientY;
            pos.x += dx;
            pos.y += dy;
            schedule(pos.x, pos.y, scale);
        };

        const tEnd = (e) => {
            lastTouchEndT = Date.now();

            if (!unlocked) {
                const start = lockedStart;
                lockedStart = null;
                if (start && e.touches.length === 0 && e.changedTouches[0]) {
                    const t = e.changedTouches[0];
                    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) <= TAP_SLOP) registerTap();
                }
                return;
            }

            if (tPinch && e.touches.length < 2) {
                tPinch = false;
                setScale(nameNow, scale, isUserNow);
            }

            if (e.touches.length === 0) {
                tActive = false;
                el.style.cursor = 'grab';
                if (tConsumed) { tConsumed = false; return; }
                if (tDrag) {
                    tDrag = false;
                    flushPending();
                    const box = readBox();
                    if (box) {
                        const safe = clampSafePosition(pos.x, pos.y, scale, box);
                        applyTransform(safe.x, safe.y, scale, false);
                        setPos(nameNow, safe.x, safe.y, isUserNow);
                    }
                    return;
                }
                registerTap();
            }
        };

        const tCancel = () => {
            tActive = false;
            tDrag = false;
            tPinch = false;
            tConsumed = false;
            lockedStart = null;
        };

        el.addEventListener('touchstart', tStart, { passive: true });
        el.addEventListener('touchmove', tMove, { passive: false });
        el.addEventListener('touchend', tEnd, { passive: true });
        el.addEventListener('touchcancel', tCancel, { passive: true });

        /* 右键 / 长按 → 同一个弹窗 */
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (tActive) tConsumed = true;
            openAvatarModal({ isUser: isUserNow, name: nameNow, label: isUserNow ? '面具' : '角色' });
        });
    }

    /* ========== 7. 介质挂载与替换 ========== */
    const isVideoSource = (info) => {
        if (!info || !info.src) return false;
        if (info.type && info.type.startsWith('video/')) return true;
        return /^(data:video\/|\S+\.(mp4|webm|mov)(\?|#|$))/i.test(info.src);
    };

    async function applyAvatar(mes, isUser) {
        if (!mes) return;
        const storeName = getStoreName(mes);
        const t = findAvatar(mes);
        if (!t || t.mode !== 'object') return;

        const container = t.container;
        if (!container) return;

        const mediaSource = await resolveAvatarSource(storeName, !!isUser);
        const existingImg = container.querySelector('img');
        const existingVideo = container.querySelector('video');

        if (mediaSource && mediaSource.src) {
            if (isVideoSource(mediaSource)) {
                if (existingVideo) {
                    if (existingVideo.getAttribute('src') !== mediaSource.src) {
                        existingVideo.src = mediaSource.src;
                        existingVideo.load();
                        existingVideo.play().catch(() => { });
                    }
                    return;
                }
                if (existingImg) {
                    if (!container.dataset.origSrc) container.dataset.origSrc = existingImg.src;
                    const video = document.createElement('video');
                    video.src = mediaSource.src;
                    video.autoplay = true;
                    video.loop = true;
                    video.muted = true;
                    video.playsInline = true;
                    video.setAttribute('playsinline', '');
                    video.preload = 'auto';
                    video.className = existingImg.className;
                    video.style.cssText = existingImg.style.cssText;
                    video.dataset.avatarCustom = '1';
                    container.replaceChild(video, existingImg);
                    setupDrag({ el: video, mode: 'object', container }, storeName, !!isUser);
                    video.play().catch(() => { });
                }
            } else {
                if (existingVideo) {
                    const img = document.createElement('img');
                    img.className = existingVideo.className;
                    img.style.cssText = existingVideo.style.cssText;
                    img.dataset.avatarCustom = '1';
                    img.src = mediaSource.src;
                    container.replaceChild(img, existingVideo);
                    setupDrag({ el: img, mode: 'object', container }, storeName, !!isUser);
                } else if (existingImg) {
                    if (!container.dataset.origSrc) container.dataset.origSrc = existingImg.src;
                    if (existingImg.getAttribute('src') !== mediaSource.src) {
                        existingImg.src = mediaSource.src;
                        existingImg.dataset.avatarCustom = '1';
                    }
                }
            }
        } else {
            /* 没有任何自定义媒体：回到酒馆原生头像 */
            if (existingVideo) {
                const img = document.createElement('img');
                img.className = existingVideo.className;
                img.style.cssText = existingVideo.style.cssText;
                const orig = container.dataset.origSrc;
                if (orig) img.src = orig;
                container.replaceChild(img, existingVideo);
                setupDrag({ el: img, mode: 'object', container }, storeName, !!isUser);
            } else if (existingImg && container.dataset.origSrc && existingImg.dataset.avatarCustom === '1') {
                existingImg.src = container.dataset.origSrc;
                delete existingImg.dataset.avatarCustom;
                delete container.dataset.origSrc;
            }
        }
    }

    /* ========== 8. 批量挂载与监听 ========== */
    function mountMessage(mes) {
        const name = getStoreName(mes);
        const isUser = isUserMessage(mes);
        const t = findAvatar(mes);
        if (!t) return;
        if (t.el.dataset.dragReady && typeof t.el.__setChar === 'function') {
            t.el.__setChar(name, isUser);
        } else {
            setupDrag(t, name, isUser);
        }
        /* 异步替换自定义头像源，不阻塞上面的同步位移 */
        applyAvatar(mes, isUser);
    }

    let sweepTimer = 0;

    function sweepAvatars() {
        sweepTimer = 0;
        const chat = document.getElementById('chat');
        if (!chat) return;
        chat.querySelectorAll('.mes').forEach((mes) => {
            const t = findAvatar(mes);
            if (!t || !t.el) return;
            if (!t.el.dataset.dragReady || typeof t.el.__applyStoredTransform !== 'function') {
                mountMessage(mes);
                return;
            }
            if (!t.el.style.width || t.el.style.width === 'auto') {
                t.el.__setChar(getStoreName(mes), isUserMessage(mes));
            }
        });
    }

    function scheduleSweep() {
        if (sweepTimer) return;
        sweepTimer = setTimeout(sweepAvatars, 250);
    }

    const isAvatarish = (node) => {
        if (!node || node.nodeType !== 1) return false;
        if (node.matches?.('img, video, .avatar, .mesAvatarWrapper')) return true;
        return !!node.querySelector?.('img, video, .avatar');
    };

    const observer = new MutationObserver((muts) => {
        for (const m of muts) {
            if (m.target && m.target.nodeType === 1 && m.target.closest?.('.avatar')) {
                scheduleSweep();
            }
            m.addedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;
                const targets = node.classList?.contains('mes') ? [node] : (node.querySelectorAll?.('.mes') || []);
                targets.forEach(mountMessage);
                if (isAvatarish(node)) scheduleSweep();
            });
            m.removedNodes.forEach((node) => {
                if (isAvatarish(node)) scheduleSweep();
            });
        }
    });

    function initAll() {
        if (unlockedEl && !unlockedEl.isConnected) unlockedEl = null;
        invalidatePersonaId();
        document.querySelectorAll('#chat .mes').forEach(mountMessage);
    }

    function observeChat() {
        const chat = document.getElementById('chat');
        if (!chat) return false;
        observer.disconnect();
        observer.observe(chat, { childList: true, subtree: true });
        return true;
    }

    /* ========== 9. 面板入口：角色头像 / 面具 Set Image ========== */
    function openPanelModal(isUser) {
        if (isUser) {
            openAvatarModal({ isUser: true, name: getPersonaId(), label: '面具' });
        } else {
            openAvatarModal({ isUser: false, name: getCharStoreName(), label: '角色' });
        }
    }

    function canWriteCharAvatarNow() {
        const ctx = getCtx();
        const ch = ctx.characters
            ? (ctx.characters[ctx.characterId] || ctx.characters[Number(ctx.characterId)])
            : null;
        return !!(ch && ch.avatar && ch.avatar !== 'none');
    }

    function bindPanelEntries() {
        /* 捕获阶段拦截：阻止酒馆自己的"选文件 → 弹原生裁剪框"流程 */
        document.addEventListener('click', (e) => {
            const t = e.target;
            if (!t || !t.closest) return;

            const personaBtn = t.closest('#persona_set_image_button');
            /* 只拦角色"头像预览"这个 label。#avatar_div 里还装着导出/删除/复制/创建按钮，
               一起拦会把整个角色面板点坏。 */
            const charLabel = t.closest('#avatar_div_div');
            if (!personaBtn && !charLabel) return;
            /* 新建角色时还没有头像文件可写：交回酒馆原生流程 */
            if (charLabel && !canWriteCharAvatarNow()) return;

            e.preventDefault();
            e.stopPropagation();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();

            openPanelModal(!!personaBtn);
        }, true);
    }

    /* ========== 10. 生命周期 ========== */
    const boot = () => {
        initAll();
        if (observeChat()) return;
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            if (observeChat() || tries > 60) clearInterval(timer);
        }, 500);
    };

    function bindStEvents() {
        try {
            const ctx = window.SillyTavern?.getContext?.();
            if (!ctx?.eventSource || !ctx?.eventTypes) return;
            const { eventSource, eventTypes } = ctx;

            const onEvent = (name, handler) => {
                const type = eventTypes[name];
                if (!type) return;
                eventSource.on(type, handler);
            };

            onEvent('APP_READY', () => { clearAllCaches(); invalidatePersonaId(); boot(); });
            onEvent('CHAT_CHANGED', () => {
                lockAvatarEdit();
                clearAllCaches();
                invalidatePersonaId();
                initAll();
            });
            onEvent('CHARACTER_SELECTED', () => {
                lockAvatarEdit();
                clearAllCaches();
                initAll();
            });
            onEvent('PERSONA_CHANGED', () => {
                clearAllCaches();
                invalidatePersonaId();
                initAll();
            });
        } catch (e) {
            console.debug('[头像扩展] 事件绑定失败，退回纯 DOM 模式', e);
        }
    }

    function start() {
        bindUnlockGuards();
        bindPanelEntries();
        boot();
        bindStEvents();
        window.addEventListener('resize', scheduleSweep);
        window.addEventListener('load', scheduleSweep, { once: true });
        console.log('%c[ST Avatar+] v1.7.2 裁剪+动态头像合并版（原生头像同步 / 位置不回弹）', 'color:#f2f2f3;font-weight:bold');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }

    /* ========== 11. 对外接口 ========== */
    window.STAvatar = {
        open: (isUser) => openPanelModal(!!isUser),
        setVideo: (name, url, isUser) => {
            setVideoUrl(name, url, !!isUser);
            clearAllCaches();
            initAll();
        },
        resetPos: (name, isUser) => {
            setPos(name, 0, 0, !!isUser);
            setScale(name, MIN_SCALE, !!isUser);
            clearAllCaches();
            initAll();
        },
        restoreNative: async (name, isUser) => {
            const k = makeKey(name, !!isUser);
            await deleteLocalFile(k);
            setVideoUrl(name, '', !!isUser);
            clearAllCaches();
            initAll();
        },
        writeNative: (blob, isUser, name) => writeNativeAvatar(!!isUser, name, blob),
        personaId: () => getPersonaId(),
        listVideos: () => load(VIDEO_KEY),
        listPositions: () => load(POS_KEY),
        listScales: () => load(SCALE_KEY),
        refresh: initAll,
    };

    window.STAvatarPlugin = window.STAvatar;
})();
