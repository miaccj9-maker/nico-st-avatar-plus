/* ============================================================
 * SillyTavern 扩展：头像拖拽 + 视频动态头像
 * （画幅自适应全览 + 零黑边锁边 + 分存档隔离）
 *
 * 由 Tampermonkey 用户脚本移植为酒馆第三方扩展。
 * v1.4.0：改为双击进入拖动模式，默认锁定，杜绝误触。
 * v1.5.0：原生头像同引擎 + 按最终像素重绘（放大不糊）+ 重渲染巡检。
 * v1.6.0：面具/存档完全独立 + 本地缓存 + 新楼层不再闪原始头像。
 * ============================================================ */
(function () {
    'use strict';

    /* ========== 存储键名 ========== */
    const VIDEO_KEY = 'st_avatar_video_urls';
    const POS_KEY = 'st_avatar_positions';
    const SCALE_KEY = 'st_avatar_scales';
    const DB_NAME = 'ST_Avatar_Local_DB';
    const DB_STORE = 'avatar_files';

    const MIN_SCALE = 1.0;
    const MAX_SCALE = 4.5;
    const SCALE_STEP = 0.15;

    /* ========== 内存缓存 ==========
     * 避免每条消息挂载都重复查 IndexedDB / 重复解析 localStorage。
     * 保存 / 切换存档时会主动失效。 */
    const mediaCache = new Map();   // key -> { src, isLocal, type } | null
    const posCache = new Map();     // key -> { x, y }
    const scaleCache = new Map();   // key -> number

    /* ========== 会话 / 存档感知系统 ========== */
    /* 记录最近一次成功解析到的存档 id：扩展启动早期读不到存档，
       以前会退成 global_chat，导致读出来的位移和拖动时存下的位移不是同一个键，
       表现就是"新消息一来头像位置就跳回去"。这里改成沿用上一次真实 id。 */
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
        } catch (e) {
            /* 忽略上下文读取失败，退回 DOM 探测 */
        }
        const chatSelect = document.getElementById('selected_chat');
        if (chatSelect && chatSelect.value) {
            return String(chatSelect.value);
        }
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
     * 键 = chatId::(u=user面具 / c=角色)::名字。
     * 这样即使两个存档里出现同名角色、或同一角色在不同面具下，
     * 位移 / 缩放 / 自定义头像也完全不会串。 */
    function makeKey(charName, isUser) {
        const prefix = isUser ? 'u' : 'c';
        return `${getChatId()}::${prefix}::${charName}`;
    }

    /* ========== 1. IndexedDB 异步二进制存储 ========== */
    let dbPromise = null;

    function getDB() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 2);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(DB_STORE)) {
                        db.createObjectStore(DB_STORE);
                    }
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
        try {
            return JSON.parse(localStorage.getItem(k) || '{}');
        } catch (e) {
            return {};
        }
    };
    const save = (k, d) => localStorage.setItem(k, JSON.stringify(d));

    /* 新键带 u/c 前缀；读时回退到旧键（v1.5 及更早），避免老设置丢失 */
    function storageKeys(charName, isUser) {
        const newK = makeKey(charName, isUser);
        const oldK = `${getChatId()}::${charName}`;
        return [newK, oldK];
    }

    const getVideoUrl = (charName, isUser) => {
        const store = load(VIDEO_KEY);
        const [k, oldK] = storageKeys(charName, isUser);
        return store[k] || store[oldK] || store[charName] || '';
    };

    const setVideoUrl = (charName, url, isUser) => {
        const d = load(VIDEO_KEY);
        const k = makeKey(charName, isUser);
        if (url) d[k] = url;
        else delete d[k];
        save(VIDEO_KEY, d);
        mediaCache.delete(k);
    };

    const getPos = (charName, isUser) => {
        const [k, oldK] = storageKeys(charName, isUser);
        if (posCache.has(k)) return posCache.get(k);
        const store = load(POS_KEY);
        const p = store[k] || store[oldK] || store[charName];
        const val = p ? { x: Number(p.x) || 0, y: Number(p.y) || 0 } : { x: 0, y: 0 };
        posCache.set(k, val);
        return val;
    };

    const setPos = (charName, x, y, isUser) => {
        const d = load(POS_KEY);
        const k = makeKey(charName, isUser);
        d[k] = { x, y };
        save(POS_KEY, d);
        posCache.set(k, { x, y });
    };

    const getScale = (charName, isUser) => {
        const [k, oldK] = storageKeys(charName, isUser);
        if (scaleCache.has(k)) return scaleCache.get(k);
        const store = load(SCALE_KEY);
        const val = Number(store[k] || store[oldK] || store[charName]) || 1.0;
        scaleCache.set(k, val);
        return val;
    };

    const setScale = (charName, s, isUser) => {
        const d = load(SCALE_KEY);
        const k = makeKey(charName, isUser);
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

    async function resolveAvatarSource(charName, isUser) {
        const k = makeKey(charName, isUser);
        /* 内存缓存命中：同步返回，不再等 IndexedDB，避免新楼层闪一下 */
        if (mediaCache.has(k)) return mediaCache.get(k);
        const localBlob = await getLocalFile(k, charName);
        let result = null;
        if (localBlob) {
            if (activeBlobUrls.has(k)) {
                URL.revokeObjectURL(activeBlobUrls.get(k));
            }
            const blobUrl = URL.createObjectURL(localBlob);
            activeBlobUrls.set(k, blobUrl);
            result = { src: blobUrl, isLocal: true, type: localBlob.type };
        } else {
            const netUrl = getVideoUrl(charName, isUser);
            if (netUrl) result = { src: netUrl, isLocal: false, type: '' };
        }
        mediaCache.set(k, result);
        return result;
    }

    /* ========== 3. 工具函数 ========== */
    const clampVal = (v, min, max) => Math.max(min, Math.min(max, v));

    /* 每个面具的唯一标识：用面具在磁盘上的文件夹 ID（不是显示名，因为可能重名）。
     * 优先从酒馆上下文读，其次从面具下拉框读。 */
    function getPersonaId() {
        try {
            const ctx = window.SillyTavern?.getContext?.();
            if (ctx) {
                // 尝试多种已知的上下文字段
                if (ctx.personaId) return String(ctx.personaId);
                if (ctx.persona_id) return String(ctx.persona_id);
                if (ctx.persona?.id) return String(ctx.persona.id);
            }
        } catch (e) {}
        // 从面具选择下拉框读 value（通常是文件夹名/UUID）
        try {
            const sel = document.getElementById('persona_select')
                || document.querySelector('select#persona_select')
                || document.querySelector('#user_settings select[name="persona"]');
            if (sel && sel.value) return 'sel_' + String(sel.value);
        } catch (e) {}
        // 最终兜底：用显示名（可能重名，但至少比没有强）
        try {
            const ctx = window.SillyTavern?.getContext?.();
            if (ctx?.name1) return 'name_' + String(ctx.name1).trim();
        } catch (e) {}
        return 'default_persona';
    }

    function getCharName(mes) {
        return mes.getAttribute('ch_name')
            || mes.querySelector('.ch_name')?.textContent?.trim()
            || mes.querySelector('.mesAvatarWrapper')?.getAttribute('ch_name')
            || 'default';
    }

    /* 判断这条消息是不是用户（面具）发的，用于独立存档键 */
    function isUserMessage(mes) {
        return mes.classList.contains('is_user')
            || mes.getAttribute('is_user') === 'true'
            || mes.getAttribute('isUser') === 'true';
    }

    /* 统一入口：拿到这条消息对应的存储名。
     * 用户面具用唯一 ID（不依赖显示名，避免重名面具串档）；
     * 角色消息用 DOM 上的 ch_name。 */
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

    /* ========== 4. 轻量弹窗 ========== */
    let modalHost = null;
    let modalResolve = null;
    let pendingFileBlob = null;

    function ensureModal() {
        if (modalHost) return modalHost;

        modalHost = document.createElement('div');
        modalHost.id = 'st-avatar-drag-modal';
        modalHost.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483000;pointer-events:none;display:none;';
        (document.documentElement || document.body).appendChild(modalHost);

        const shadow = modalHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
<style>
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; font-family: inherit; }
.overlay {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.45);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    padding: 20px; pointer-events: auto;
    animation: fadeIn .18s ease-out;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(12px) scale(.97); } to { opacity: 1; transform: none; } }
.card {
    width: min(92vw, 380px); max-height: 86vh; overflow-y: auto;
    background: rgba(28,29,36,.92);
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 16px;
    padding: 22px;
    color: #f0f0f2;
    box-shadow: 0 20px 60px rgba(0,0,0,.4);
    animation: slideUp .22s cubic-bezier(.2,.8,.2,1);
}
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; }
.badge {
    font-size: 10px; font-weight: 600; letter-spacing: .5px;
    padding: 2px 8px; border-radius: 6px; text-transform: uppercase;
}
.badge.persona { background: rgba(16,185,129,.15); color: #34d399; }
.badge.char    { background: rgba(74,144,226,.15); color: #60a5fa; }
.title { font-size: 16px; font-weight: 600; color: #f0f0f2; }
.input-row { display: flex; gap: 8px; margin-bottom: 8px; }
input[type=url] {
    flex: 1; padding: 11px 14px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,.1); background: rgba(0,0,0,.25); color: #fff;
    font-size: 14px; outline: none; transition: border-color .15s;
}
input[type=url]:focus { border-color: rgba(74,144,226,.6); }
input[type=url]::placeholder { color: rgba(255,255,255,.3); }
.file-btn {
    padding: 0 14px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
    border-radius: 10px; color: #e2e8f0; font-size: 13px; font-weight: 500;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    white-space: nowrap; -webkit-tap-highlight-color: transparent;
    transition: background .15s;
}
.file-btn:hover { background: rgba(255,255,255,.12); }
.file-btn svg { width: 14px; height: 14px; margin-right: 6px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.status-tip { font-size: 12px; color: #34d399; margin: 6px 0 2px; display: none; }
.hint { margin-top: 12px; font-size: 11.5px; color: rgba(255,255,255,.35); line-height: 1.6; }
.hint b { color: rgba(255,255,255,.55); font-weight: 500; }
.btns { display: flex; gap: 8px; margin-top: 18px; }
button {
    border: none; border-radius: 10px; padding: 11px 0; cursor: pointer;
    font-size: 14px; font-weight: 500; -webkit-tap-highlight-color: transparent;
    transition: opacity .12s, background .12s;
}
button:active { opacity: .75; }
.primary { flex: 1.5; background: #4a90e2; color: #fff; font-weight: 600; }
.primary:hover { background: #3a7fd1; }
.restore { flex: 1; background: rgba(255,255,255,.06); color: #f87171; border: 1px solid rgba(248,113,113,.25); }
.restore:hover { background: rgba(248,113,113,.12); }
.cancel { flex: .8; background: transparent; color: rgba(255,255,255,.4); }
.cancel:hover { background: rgba(255,255,255,.06); }
.divider { height: 1px; background: rgba(255,255,255,.06); margin: 14px 0 0; }
.reset-pos {
    display: block; width: 100%; text-align: center; margin-top: 10px;
    font-size: 12px; color: rgba(255,255,255,.3); background: none;
}
.reset-pos:hover { color: rgba(255,255,255,.6); }
</style>
<div class="overlay">
    <div class="card">
        <div class="head">
            <span class="badge" id="badge"></span>
            <div class="title" id="title"></div>
        </div>
        <div class="input-row">
            <input id="input" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"
                   placeholder="粘贴图片/视频链接"/>
            <button class="file-btn" id="uploadBtn">
                <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                本地上传
            </button>
            <input type="file" id="fileInput" accept="video/mp4,video/webm,image/gif,image/png,image/jpeg,image/webp" style="display:none;"/>
        </div>
        <div class="status-tip" id="statusTip"></div>
        <div class="hint">
            <b>双击头像</b>进入拖动 · 滚轮/双指缩放<br>
            设置独立绑定当前角色与当前存档，互不干扰
        </div>
        <div class="btns">
            <button class="cancel" id="cancel">取消</button>
            <button class="restore" id="restore">恢复原生</button>
            <button class="primary" id="ok">应用</button>
        </div>
        <button class="reset-pos" id="reset">重置位置与缩放</button>
    </div>
</div>`;

        const title = shadow.getElementById('title');
        const badge = shadow.getElementById('badge');
        const input = shadow.getElementById('input');
        const uploadBtn = shadow.getElementById('uploadBtn');
        const fileInput = shadow.getElementById('fileInput');
        const statusTip = shadow.getElementById('statusTip');
        const restoreBtn = shadow.getElementById('restore');
        const resetPosBtn = shadow.getElementById('reset');
        const cancelBtn = shadow.getElementById('cancel');
        const okBtn = shadow.getElementById('ok');
        const overlay = shadow.querySelector('.overlay');

        const close = (val) => {
            modalHost.style.display = 'none';
            pendingFileBlob = null;
            statusTip.style.display = 'none';
            if (modalResolve) modalResolve(val);
            modalResolve = null;
        };

        uploadBtn.addEventListener('click', () => fileInput.click());
        input.addEventListener('input', () => {
            if (input.value.trim()) {
                pendingFileBlob = null;
                statusTip.style.display = 'none';
            }
        });

        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (!file) return;
            pendingFileBlob = file;
            input.value = '';
            statusTip.textContent = `已就绪: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
            statusTip.style.display = 'block';
            fileInput.value = '';
        });

        /* 恢复原生：清除自定义头像源（本地文件+URL），回到酒馆原生头像，保留位置/缩放 */
        restoreBtn.addEventListener('click', async () => {
            const name = modalHost.dataset.charName;
            const isUser = modalHost.dataset.isUser === '1';
            const k = makeKey(name, isUser);
            setVideoUrl(name, '', isUser);
            await deleteLocalFile(k);
            if (activeBlobUrls.has(k)) {
                URL.revokeObjectURL(activeBlobUrls.get(k));
                activeBlobUrls.delete(k);
            }
            clearAllCaches();
            initAll();
            close({ restore: true });
        });

        /* 重置位置与缩放：只清位移/缩放，不动自定义头像源 */
        resetPosBtn.addEventListener('click', () => {
            const name = modalHost.dataset.charName;
            const isUser = modalHost.dataset.isUser === '1';
            setPos(name, 0, 0, isUser);
            setScale(name, MIN_SCALE, isUser);
            clearAllCaches();
            initAll();
            close({ resetPos: true });
        });

        cancelBtn.addEventListener('click', () => close({ cancel: true }));

        okBtn.addEventListener('click', async () => {
            const name = modalHost.dataset.charName;
            const isUser = modalHost.dataset.isUser === '1';
            const k = makeKey(name, isUser);
            const textUrl = input.value.trim();

            if (pendingFileBlob) {
                await saveLocalFile(k, pendingFileBlob);
                setVideoUrl(name, '', isUser);
            } else {
                await deleteLocalFile(k);
                if (activeBlobUrls.has(k)) {
                    URL.revokeObjectURL(activeBlobUrls.get(k));
                    activeBlobUrls.delete(k);
                }
                setVideoUrl(name, textUrl, isUser);
            }
            clearAllCaches();
            initAll();
            close({ ok: true });
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close({ cancel: true });
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') okBtn.click();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modalHost.style.display !== 'none') close({ cancel: true });
        });

        return modalHost;
    }

    async function openVideoModal(charName, isUser) {
        ensureModal();
        const shadow = modalHost.shadowRoot;
        modalHost.dataset.charName = charName;
        modalHost.dataset.isUser = isUser ? '1' : '';
        const k = makeKey(charName, !!isUser);
        shadow.getElementById('title').textContent = isUser ? '我的面具' : charName;
        const badge = shadow.getElementById('badge');
        badge.textContent = isUser ? '面具' : '角色';
        badge.className = 'badge ' + (isUser ? 'persona' : 'char');
        shadow.getElementById('input').value = getVideoUrl(charName, !!isUser);
        pendingFileBlob = null;

        const hasLocal = await getLocalFile(k, charName);
        const statusTip = shadow.getElementById('statusTip');
        if (hasLocal) {
            statusTip.textContent = `本地文件 · ${(hasLocal.size / (1024 * 1024)).toFixed(1)} MB`;
            statusTip.style.display = 'block';
        } else {
            statusTip.style.display = 'none';
        }

        modalHost.style.display = 'block';
        setTimeout(() => shadow.getElementById('input').focus(), 100);
        return new Promise((resolve) => {
            modalResolve = resolve;
        });
    }

    /* ========== 5. 核心：自适应画幅物理覆盖与锁边位移引擎 ========== */

    /** 当前处于"编辑模式"（可拖动）的那个头像元素 */
    let unlockedEl = null;

    function lockAvatarEdit() {
        if (unlockedEl && typeof unlockedEl.__lockAvatar === 'function') {
            unlockedEl.__lockAvatar();
        }
        unlockedEl = null;
    }

    /** 点空白处 / 按 Esc 退出编辑模式，避免拖完忘记锁定又误触 */
    function bindUnlockGuards() {
        document.addEventListener('pointerdown', (e) => {
            if (!unlockedEl) return;
            if (e.target === unlockedEl || unlockedEl.contains(e.target)) return;
            lockAvatarEdit();
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !unlockedEl) return;
            if (modalHost && modalHost.style.display !== 'none') return; // 弹窗优先处理
            lockAvatarEdit();
        });
    }

    function setupDrag(target, charName, isUser) {
        const el = target.el;
        const mode = target.mode;
        const container = target.container;
        if (!el) return;

        if (container) {
            container.style.overflow = 'hidden';
            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }
        }

        // 角色名 / 面具类型可能随存档切换而变化，用可变值，避免重复绑定事件
        let charNameNow = charName;
        let isUserNow = !!isUser;
        let pos = getPos(charNameNow, isUserNow);
        let scale = Math.max(MIN_SCALE, getScale(charNameNow, isUserNow));
        let raf = 0;

        const getMediaIntrinsicSize = () => {
            if (mode === 'background') return null;
            if (el.tagName === 'VIDEO') {
                return { w: el.videoWidth || 0, h: el.videoHeight || 0 };
            }
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

        const clampSafePosition = (x, y, s) => {
            if (!container) return { x: 0, y: 0 };
            const rect = container.getBoundingClientRect();
            const boxW = rect.width || container.offsetWidth || 60;
            const boxH = rect.height || container.offsetHeight || 60;

            const { renderW, renderH } = getRenderDimensions(boxW, boxH);
            const totalW = renderW * s;
            const totalH = renderH * s;

            const maxX = Math.max(0, (totalW - boxW) / 2);
            const maxY = Math.max(0, (totalH - boxH) / 2);

            return {
                x: clampVal(x, -maxX, maxX),
                y: clampVal(y, -maxY, maxY),
            };
        };

        const applyTransform = (x, y, s, fromRestore) => {
            if (!container) return;
            const rect = container.getBoundingClientRect();
            const boxW = rect.width || container.offsetWidth || 60;
            const boxH = rect.height || container.offsetHeight || 60;

            const { renderW, renderH } = getRenderDimensions(boxW, boxH);
            let safe;
            if (fromRestore) {
                /* 恢复存档位置时不重新 clamp：
                 * 新消息刚插入时图片可能还没加载完（naturalWidth=0），
                 * 这时 clamp 会把已保存的位置错误归零。
                 * 图片加载完成后的 reapply 会用真实尺寸再 clamp 一次。 */
                safe = { x, y };
            } else {
                safe = clampSafePosition(x, y, s);
            }
            pos.x = safe.x;
            pos.y = safe.y;
            scale = s;

            if (mode === 'background') {
                const bgW = s * 100;
                el.style.backgroundSize = `${bgW}% auto`;
                el.style.backgroundPosition = `calc(50% + ${pos.x}px) calc(50% + ${pos.y}px)`;
            } else {
                /* 关键：放大不用 transform: scale()。
                   transform 缩放是把已经栅格化好的位图再拉伸，放得越大越糊；
                   这里直接把元素宽高按"渲染尺寸 × 缩放"算成整数像素，
                   浏览器每次都是按最终尺寸重新采样原图，放大后依然是原图分辨率。 */
                const drawW = Math.max(1, Math.round(renderW * s));
                const drawH = Math.max(1, Math.round(renderH * s));
                const offX = Math.round(pos.x);
                const offY = Math.round(pos.y);

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
                /* 只做整数像素位移，避免半像素重采样带来的糊边 */
                el.style.transform = `translate3d(calc(-50% + ${offX}px), calc(-50% + ${offY}px), 0px)`;
            }
        };

        el.__applyStoredTransform = () => {
            pos = getPos(charNameNow, isUserNow);
            scale = Math.max(MIN_SCALE, getScale(charNameNow, isUserNow));
            applyTransform(pos.x, pos.y, scale, true);
        };

        // 存档 / 角色切换时复用同一套事件绑定，只更新角色名与位移
        el.__setChar = (name, isUser) => {
            charNameNow = name;
            if (typeof isUser === 'boolean') isUserNow = isUser;
            el.__applyStoredTransform();
        };

        if (el.dataset.dragReady) {
            return;
        }
        el.dataset.dragReady = '1';

        const schedule = (x, y, s) => {
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                applyTransform(x, y, s);
            });
        };

        const reapply = () => {
            try { el.__applyStoredTransform(); } catch (e) { /* 元素已移除 */ }
        };

        if (el.tagName === 'IMG') {
            // 每次加载完成都重算：酒馆重新渲染头像 / 换了图源后，尺寸会变
            el.addEventListener('load', reapply);
            el.addEventListener('error', reapply);
            /* 浏览器缓存命中时 load 事件可能在绑监听器之前就触发了，
             * 这里补一帧：等布局稳定后再按存档位置重绘一次，
             * 避免新楼层因容器尺寸还没算出来而用 60px 兜底、看起来像回到原位。 */
            if (el.complete) {
                requestAnimationFrame(reapply);
            }
        } else if (el.tagName === 'VIDEO') {
            el.addEventListener('loadedmetadata', reapply);
            el.addEventListener('loadeddata', reapply);
            requestAnimationFrame(reapply);
        }

        el.__applyStoredTransform();
        /* 再补一帧：确保容器尺寸已布局完成（新插入的 DOM 节点第一帧 rect 可能为 0） */
        requestAnimationFrame(reapply);

        /* ---------- 交互锁：默认锁定，双击才进入编辑模式，杜绝误触 ---------- */
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
                el.style.outline = '2px solid rgba(74,144,226,.9)';
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

        /** 双击 / 双击轻点：进入或退出编辑模式 */
        const registerTap = () => {
            const now = Date.now();
            if (now - lastTapT < DBL_TAP_MS) {
                lastTapT = 0;
                setUnlocked(!unlocked);
            } else {
                lastTapT = now;
            }
        };

        /* 桌面端：滚轮缩放（仅编辑模式生效；锁定时不拦页面滚动） */
        el.addEventListener('wheel', (e) => {
            if (!unlocked) return;
            e.preventDefault();
            e.stopPropagation();
            const step = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
            const newScale = clampVal(Math.round((scale + step) * 100) / 100, MIN_SCALE, MAX_SCALE);
            schedule(pos.x, pos.y, newScale);
            setScale(charNameNow, newScale, isUserNow);
        }, { passive: false });

        /* 桌面端：鼠标平移（锁定时完全不响应，避免误触拖走头像） */
        let mDrag = false;
        let mLastX = 0;
        let mLastY = 0;

        const mDown = (e) => {
            if (!unlocked || e.button !== 0) return;
            mDrag = true;
            mLastX = e.clientX;
            mLastY = e.clientY;
            el.style.cursor = 'grabbing';
            e.preventDefault();
            e.stopPropagation();
            // 只在拖拽期间监听 document，避免每个头像常驻全局事件
            document.addEventListener('mousemove', mMove);
            document.addEventListener('mouseup', mUp);
        };

        const mMove = (e) => {
            if (!mDrag) return;
            const dx = e.clientX - mLastX;
            const dy = e.clientY - mLastY;
            schedule(pos.x + dx, pos.y + dy, scale);
            mLastX = e.clientX;
            mLastY = e.clientY;
        };

        const mUp = () => {
            document.removeEventListener('mousemove', mMove);
            document.removeEventListener('mouseup', mUp);
            if (!mDrag) return;
            mDrag = false;
            el.style.cursor = unlocked ? 'grab' : '';
            if (raf) {
                cancelAnimationFrame(raf);
                raf = 0;
            }
            const safe = clampSafePosition(pos.x, pos.y, scale);
            applyTransform(safe.x, safe.y, scale); // 补一帧，避免极快拖动时画面没跟上
            setPos(charNameNow, safe.x, safe.y, isUserNow);
        };

        el.addEventListener('mousedown', mDown);

        /* 双击进入编辑模式（触屏双击由下方 touch 逻辑处理，避免重复触发） */
        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (Date.now() - lastTouchEndT < 800) return;
            setUnlocked(!unlocked);
        });

        /* 移动端：锁定时只判断"轻点"；进入编辑模式后才单指平移、双指缩放 */
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
                // 只记录起点，不拦截任何默认行为，页面滚动照常
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
                        Math.round((pinchStartScale * factor) * 100) / 100,
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
            schedule(pos.x + dx, pos.y + dy, scale);
            tLastX = t.clientX;
            tLastY = t.clientY;
        };

        const tEnd = (e) => {
            lastTouchEndT = Date.now();

            if (!unlocked) {
                // 只有"几乎没位移"的轻点才计入双击，滑动聊天列表不会误解锁
                const start = lockedStart;
                lockedStart = null;
                if (start && e.touches.length === 0 && e.changedTouches[0]) {
                    const t = e.changedTouches[0];
                    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) <= TAP_SLOP) {
                        registerTap();
                    }
                }
                return;
            }

            if (tPinch && e.touches.length < 2) {
                tPinch = false;
                setScale(charNameNow, scale, isUserNow);
            }

            if (e.touches.length === 0) {
                tActive = false;
                el.style.cursor = 'grab';

                if (tConsumed) {
                    tConsumed = false;
                    return;
                }

                if (tDrag) {
                    tDrag = false;
                    if (raf) {
                        cancelAnimationFrame(raf);
                        raf = 0;
                    }
                    const safe = clampSafePosition(pos.x, pos.y, scale);
                    applyTransform(safe.x, safe.y, scale);
                    setPos(charNameNow, safe.x, safe.y, isUserNow);
                    return;
                }

                registerTap(); // 编辑模式下再次双击 = 退出
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

        /* 弹窗唤醒：桌面右键 / 移动端长按 */
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isLongPress = tActive;
            if (isLongPress) tConsumed = true;
            openVideoModal(charNameNow, isUserNow);
        });
    }

    /* ========== 6. 介质挂载与替换 ========== */
    const isVideoSource = (info) => {
        if (!info || !info.src) return false;
        if (info.type && info.type.startsWith('video/')) return true;
        return /\.(mp4|webm)($|\?)/i.test(info.src);
    };

    async function applyAvatar(mes, isUser) {
        if (!mes) return;
        const charName = getStoreName(mes);
        const t = findAvatar(mes);
        if (!t || t.mode !== 'object') return;

        const container = t.container;
        if (!container) return;

        const mediaSource = await resolveAvatarSource(charName, !!isUser);
        const existingImg = container.querySelector('img');
        const existingVideo = container.querySelector('video');

        if (mediaSource && mediaSource.src) {
            if (isVideoSource(mediaSource)) {
                if (existingImg) {
                    container.dataset.origSrc = existingImg.src;
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
                    container.replaceChild(video, existingImg);
                    setupDrag({ el: video, mode: 'object', container }, charName, !!isUser);
                    video.play().catch(() => { });
                } else if (existingVideo && existingVideo.src !== mediaSource.src) {
                    existingVideo.src = mediaSource.src;
                    existingVideo.load();
                    existingVideo.play().catch(() => { });
                }
            } else {
                if (existingVideo) {
                    const img = document.createElement('img');
                    img.className = existingVideo.className;
                    img.style.cssText = existingVideo.style.cssText;
                    img.src = mediaSource.src;
                    container.replaceChild(img, existingVideo);
                    setupDrag({ el: img, mode: 'object', container }, charName, !!isUser);
                } else if (existingImg) {
                    if (!container.dataset.origSrc) container.dataset.origSrc = existingImg.src;
                    if (existingImg.src !== mediaSource.src) existingImg.src = mediaSource.src;
                }
            }
        } else if (existingVideo) {
            const img = document.createElement('img');
            img.className = existingVideo.className;
            img.style.cssText = existingVideo.style.cssText;
            img.src = container.dataset.origSrc || existingVideo.getAttribute('data-orig-src') || '';
            container.replaceChild(img, existingVideo);
            setupDrag({ el: img, mode: 'object', container }, charName, !!isUser);
        } else if (existingImg && container.dataset.origSrc) {
            existingImg.src = container.dataset.origSrc;
            delete container.dataset.origSrc;
        }
    }

    /* ========== 7. 批量挂载与监听 ========== */
    /** 挂载头像：已挂过的元素只更新角色名与位移，不重复绑定事件。
     *  关键：位移/缩放是同步从 localStorage 读的，必须在同一调用栈里写进内联样式，
     *  不能等 applyAvatar 的异步 IndexedDB 回来——否则新楼层会先闪一帧原生头像。 */
    function mountMessage(mes) {
        const isUser = isUserMessage(mes);
        const name = getStoreName(mes);
        const t = findAvatar(mes);
        if (!t) return;
        if (t.el.dataset.dragReady && typeof t.el.__setChar === 'function') {
            t.el.__setChar(name, isUser);
        } else {
            setupDrag(t, name, isUser);
        }
        /* 异步替换自定义头像源（视频/图片），不阻塞上面的同步位移 */
        applyAvatar(mes, isUser);
    }

    /* 带自定义 UI 的酒馆在插楼 / 重新渲染时会把头像元素整个换掉：
       新元素既没有绑定、也没有内联尺寸，于是又回到主题默认的居中裁切，
       看起来就像"位置被打回原样"。这里做一次防抖巡检，按已存位移重新挂回去。 */
    let sweepTimer = 0;

    function sweepAvatars() {
        sweepTimer = 0;
        const chat = document.getElementById('chat');
        if (!chat) return;
        chat.querySelectorAll('.mes').forEach((mes) => {
            const t = findAvatar(mes);
            if (!t || !t.el) return;
            if (!t.el.dataset.dragReady || typeof t.el.__applyStoredTransform !== 'function') {
                mountMessage(mes);   // 元素被换过：重新绑定 + 按存档位置重绘
                return;
            }
            // 元素还在，但内联尺寸被外部样式或重渲染冲掉了
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
        document.querySelectorAll('#chat .mes').forEach(mountMessage);
    }

    function observeChat() {
        const chat = document.getElementById('chat');
        if (!chat) return false;
        observer.disconnect();
        observer.observe(chat, { childList: true, subtree: true });
        return true;
    }

    /* ========== 8. 生命周期 ========== */
    const boot = () => {
        initAll();
        if (observeChat()) return;

        // #chat 还没渲染出来时，等它出现再挂监听
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

            // 事件名在不同酒馆版本里可能缺失，缺了就跳过，不影响 DOM 兜底
            const onEvent = (name, handler) => {
                const type = eventTypes[name];
                if (!type) return;
                eventSource.on(type, handler);
            };

            onEvent('APP_READY', () => { clearAllCaches(); boot(); });
            onEvent('CHAT_CHANGED', () => {
                lockAvatarEdit();
                clearAllCaches();   // 换存档后旧缓存必须失效，否则串档
                initAll();
            });
            onEvent('CHARACTER_SELECTED', () => {
                lockAvatarEdit();
                clearAllCaches();   // 换角色后清缓存
                initAll();
            });
        } catch (e) {
            console.debug('[头像扩展] 事件绑定失败，退回纯 DOM 模式', e);
        }
    }

    function start() {
        bindUnlockGuards();
        boot();
        bindStEvents();
        // 窗口尺寸变化后头像框尺寸也会变，重新按存档位移重绘一次
        window.addEventListener('resize', scheduleSweep);
        window.addEventListener('load', scheduleSweep, { once: true });
        console.log('%c[ST Avatar+] 1.6.1 面具独立 · 恢复原生 · 高清无闪烁', 'color:#4a90e2;font-weight:bold');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }

    /* ========== 9. 对外接口 ========== */
    window.STAvatar = {
        setVideo: (charName, url, isUser) => {
            setVideoUrl(charName, url, !!isUser);
            clearAllCaches();
            initAll();
        },
        resetPos: (charName, isUser) => {
            setPos(charName, 0, 0, !!isUser);
            setScale(charName, MIN_SCALE, !!isUser);
            clearAllCaches();
            initAll();
        },
        listVideos: () => load(VIDEO_KEY),
        listPositions: () => load(POS_KEY),
        listScales: () => load(SCALE_KEY),
        refresh: initAll,
    };

    window.STAvatarPlugin = window.STAvatar;
})();
