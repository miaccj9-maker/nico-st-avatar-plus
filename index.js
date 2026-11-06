/* ============================================================
 * SillyTavern 扩展：头像拖拽 + 视频动态头像
 * （画幅自适应全览 + 零黑边锁边 + 分存档隔离）
 *
 * 由 Tampermonkey 用户脚本移植为酒馆第三方扩展。
 * v1.4.0：改为双击进入拖动模式，默认锁定，杜绝误触。
 * 数据仍写在同一浏览器的 localStorage / IndexedDB，
 * 与旧用户脚本的数据可以直接互通。
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

    /* ========== 会话 / 存档感知系统 ========== */
    function getChatId() {
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
        return 'global_chat';
    }

    function makeKey(charName) {
        return `${getChatId()}::${charName}`;
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

    const getVideoUrl = (charName) => {
        const store = load(VIDEO_KEY);
        const k = makeKey(charName);
        return store[k] || store[charName] || '';
    };

    const setVideoUrl = (charName, url) => {
        const d = load(VIDEO_KEY);
        const k = makeKey(charName);
        if (url) d[k] = url;
        else delete d[k];
        save(VIDEO_KEY, d);
    };

    const getPos = (charName) => {
        const store = load(POS_KEY);
        const k = makeKey(charName);
        const p = store[k] || store[charName];
        return p ? { x: Number(p.x) || 0, y: Number(p.y) || 0 } : { x: 0, y: 0 };
    };

    const setPos = (charName, x, y) => {
        const d = load(POS_KEY);
        const k = makeKey(charName);
        d[k] = { x, y };
        save(POS_KEY, d);
    };

    const getScale = (charName) => {
        const store = load(SCALE_KEY);
        const k = makeKey(charName);
        return Number(store[k] || store[charName]) || 1.0;
    };

    const setScale = (charName, s) => {
        const d = load(SCALE_KEY);
        const k = makeKey(charName);
        if (s && s > MIN_SCALE) d[k] = s;
        else delete d[k];
        save(SCALE_KEY, d);
    };

    const activeBlobUrls = new Map();

    async function resolveAvatarSource(charName) {
        const k = makeKey(charName);
        const localBlob = await getLocalFile(k, charName);
        if (localBlob) {
            if (activeBlobUrls.has(k)) {
                URL.revokeObjectURL(activeBlobUrls.get(k));
            }
            const blobUrl = URL.createObjectURL(localBlob);
            activeBlobUrls.set(k, blobUrl);
            return { src: blobUrl, isLocal: true, type: localBlob.type };
        }
        const netUrl = getVideoUrl(charName);
        if (netUrl) {
            return { src: netUrl, isLocal: false, type: '' };
        }
        return null;
    }

    /* ========== 3. 工具函数 ========== */
    const clampVal = (v, min, max) => Math.max(min, Math.min(max, v));

    function getCharName(mes) {
        return mes.getAttribute('ch_name')
            || mes.querySelector('.ch_name')?.textContent?.trim()
            || mes.querySelector('.mesAvatarWrapper')?.getAttribute('ch_name')
            || 'default';
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
    background: rgba(0,0,0,.5);
    padding: 20px; pointer-events: auto;
}
.card {
    width: min(92vw, 420px); max-height: 88vh; overflow-y: auto;
    background: #1e1f26;
    border: 1px solid #3a3b45;
    border-radius: 12px;
    padding: 16px;
    color: #e6e6e6;
    box-shadow: 0 10px 30px rgba(0,0,0,.5);
}
.title { font-size: 15px; font-weight: 600; color: #e6e6e6; margin-bottom: 12px; }
.input-row { display: flex; gap: 8px; margin-bottom: 6px; }
input[type=url] {
    flex: 1; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #3a3b45; background: #14151b; color: #fff;
    font-size: 14px; outline: none;
}
input[type=url]:focus { border-color: #4a90e2; }
.file-btn {
    padding: 0 12px; background: #2f303b; border: 1px solid #4a4b57;
    border-radius: 8px; color: #e2e8f0; font-size: 13px; font-weight: 500;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    white-space: nowrap; -webkit-tap-highlight-color: transparent;
}
.file-btn:hover { background: #3b3c4a; }
.file-btn svg { width: 14px; height: 14px; margin-right: 6px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.status-tip { font-size: 12px; color: #10b981; margin-bottom: 6px; display: none; }
.hint { margin-top: 6px; font-size: 12px; color: #9a9aa5; line-height: 1.4; }
.btns { display: flex; gap: 8px; margin-top: 14px; }
button {
    border: none; border-radius: 8px; padding: 10px 0; cursor: pointer;
    font-size: 14px; color: #fff; -webkit-tap-highlight-color: transparent;
}
button:active { opacity: .8; }
.primary { flex: 1.6; background: #4a90e2; font-weight: 600; }
.ghost   { flex: 1.2; background: #3a3b45; }
.cancel  { flex: 1;   background: #2a2b33; color: #aaa; }
</style>
<div class="overlay">
    <div class="card">
        <div class="title" id="title"></div>
        <div class="input-row">
            <input id="input" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"
                   placeholder="网络链接 或 选择本地文件"/>
            <button class="file-btn" id="uploadBtn">
                <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                本地文件
            </button>
            <input type="file" id="fileInput" accept="video/mp4,video/webm,image/gif,image/png,image/jpeg,image/webp" style="display:none;"/>
        </div>
        <div class="status-tip" id="statusTip"></div>
        <div class="hint">
            • 当前设置仅绑定在当前聊天存档中生效，实现不同存档互不干扰<br>
            • 双击头像进入拖动模式后，滚轮 / 双指捏合缩放，单指 / 鼠标平移<br>
            • 再次双击、点空白处或按 Esc 退出；未进入模式时头像不会误触移动<br>
            • 动态锁边算法：牢牢填满原生框，绝不脱框留黑
        </div>
        <div class="btns">
            <button class="ghost" id="reset">复位</button>
            <button class="cancel" id="cancel">取消</button>
            <button class="primary" id="ok">确定</button>
        </div>
    </div>
</div>`;

        const title = shadow.getElementById('title');
        const input = shadow.getElementById('input');
        const uploadBtn = shadow.getElementById('uploadBtn');
        const fileInput = shadow.getElementById('fileInput');
        const statusTip = shadow.getElementById('statusTip');
        const resetBtn = shadow.getElementById('reset');
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

        resetBtn.addEventListener('click', async () => {
            const name = modalHost.dataset.charName;
            const k = makeKey(name);
            setPos(name, 0, 0);
            setScale(name, MIN_SCALE);
            setVideoUrl(name, '');
            await deleteLocalFile(k);
            if (activeBlobUrls.has(k)) {
                URL.revokeObjectURL(activeBlobUrls.get(k));
                activeBlobUrls.delete(k);
            }
            initAll();
            close({ reset: true });
        });

        cancelBtn.addEventListener('click', () => close({ cancel: true }));

        okBtn.addEventListener('click', async () => {
            const name = modalHost.dataset.charName;
            const k = makeKey(name);
            const textUrl = input.value.trim();

            if (pendingFileBlob) {
                await saveLocalFile(k, pendingFileBlob);
                setVideoUrl(name, '');
            } else {
                await deleteLocalFile(k);
                if (activeBlobUrls.has(k)) {
                    URL.revokeObjectURL(activeBlobUrls.get(k));
                    activeBlobUrls.delete(k);
                }
                setVideoUrl(name, textUrl);
            }

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

    async function openVideoModal(charName) {
        ensureModal();
        const shadow = modalHost.shadowRoot;
        modalHost.dataset.charName = charName;
        const k = makeKey(charName);
        shadow.getElementById('title').textContent = `【${charName}】头像设置 (当前会话)`;
        shadow.getElementById('input').value = getVideoUrl(charName);
        pendingFileBlob = null;

        const hasLocal = await getLocalFile(k, charName);
        const statusTip = shadow.getElementById('statusTip');
        if (hasLocal) {
            statusTip.textContent = `当前使用本地存储 (${(hasLocal.size / (1024 * 1024)).toFixed(1)} MB)`;
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

    function setupDrag(target, charName) {
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

        // 角色名可能随存档切换而变化，用可变值，避免重复绑定事件
        let charNameNow = charName;
        let pos = getPos(charNameNow);
        let scale = Math.max(MIN_SCALE, getScale(charNameNow));
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

        const applyTransform = (x, y, s) => {
            if (!container) return;
            const rect = container.getBoundingClientRect();
            const boxW = rect.width || container.offsetWidth || 60;
            const boxH = rect.height || container.offsetHeight || 60;

            const { renderW, renderH } = getRenderDimensions(boxW, boxH);
            const safe = clampSafePosition(x, y, s);
            pos.x = safe.x;
            pos.y = safe.y;
            scale = s;

            if (mode === 'background') {
                const bgW = s * 100;
                el.style.backgroundSize = `${bgW}% auto`;
                el.style.backgroundPosition = `calc(50% + ${pos.x}px) calc(50% + ${pos.y}px)`;
            } else {
                el.style.position = 'absolute';
                el.style.left = '50%';
                el.style.top = '50%';
                el.style.width = `${renderW}px`;
                el.style.height = `${renderH}px`;
                el.style.minWidth = `${renderW}px`;
                el.style.minHeight = `${renderH}px`;
                el.style.maxWidth = 'none';
                el.style.maxHeight = 'none';
                el.style.objectFit = 'cover';
                el.style.display = 'block';
                el.style.transformOrigin = 'center center';
                el.style.transform = `translate3d(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px), 0px) scale(${scale})`;
            }
        };

        el.__applyStoredTransform = () => {
            pos = getPos(charNameNow);
            scale = Math.max(MIN_SCALE, getScale(charNameNow));
            applyTransform(pos.x, pos.y, scale);
        };

        // 存档 / 角色切换时复用同一套事件绑定，只更新角色名与位移
        el.__setChar = (name) => {
            charNameNow = name;
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

        if (el.tagName === 'IMG') {
            if (!el.complete) {
                el.addEventListener('load', () => el.__applyStoredTransform(), { once: true });
            }
        } else if (el.tagName === 'VIDEO') {
            if (el.readyState < 1) {
                el.addEventListener('loadedmetadata', () => el.__applyStoredTransform(), { once: true });
            }
        }

        el.__applyStoredTransform();

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
            setScale(charNameNow, newScale);
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
            setPos(charNameNow, safe.x, safe.y);
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
                setScale(charNameNow, scale);
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
                    setPos(charNameNow, safe.x, safe.y);
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
            openVideoModal(charNameNow);
        });
    }

    /* ========== 6. 介质挂载与替换 ========== */
    const isVideoSource = (info) => {
        if (!info || !info.src) return false;
        if (info.type && info.type.startsWith('video/')) return true;
        return /\.(mp4|webm)($|\?)/i.test(info.src);
    };

    async function applyAvatar(mes) {
        if (!mes) return;
        const charName = getCharName(mes);
        const t = findAvatar(mes);
        if (!t || t.mode !== 'object') return;

        const container = t.container;
        if (!container) return;

        const mediaSource = await resolveAvatarSource(charName);
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
                    setupDrag({ el: video, mode: 'object', container }, charName);
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
                    setupDrag({ el: img, mode: 'object', container }, charName);
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
            setupDrag({ el: img, mode: 'object', container }, charName);
        } else if (existingImg && container.dataset.origSrc) {
            existingImg.src = container.dataset.origSrc;
            delete container.dataset.origSrc;
        }
    }

    /* ========== 7. 批量挂载与监听 ========== */
    /** 挂载头像：已挂过的元素只更新角色名与位移，不重复绑定事件 */
    function mountMessage(mes) {
        const name = getCharName(mes);
        const t = findAvatar(mes);
        if (!t) return;
        if (t.el.dataset.dragReady && typeof t.el.__setChar === 'function') {
            t.el.__setChar(name);
        } else {
            setupDrag(t, name);
        }
        applyAvatar(mes);
    }

    function initAll() {
        if (unlockedEl && !unlockedEl.isConnected) unlockedEl = null;
        document.querySelectorAll('#chat .mes').forEach(mountMessage);
    }

    const observer = new MutationObserver((muts) => {
        for (const m of muts) {
            m.addedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;
                const targets = node.classList?.contains('mes') ? [node] : (node.querySelectorAll?.('.mes') || []);
                targets.forEach(mountMessage);
            });
        }
    });

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

            onEvent('APP_READY', () => boot());
            onEvent('CHAT_CHANGED', () => {
                lockAvatarEdit();
                initAll();
            });
            onEvent('CHARACTER_SELECTED', () => {
                lockAvatarEdit();
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
        console.log('%c[ST Avatar+] 1.4.0 双击编辑版就绪', 'color:#4a90e2;font-weight:bold');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }

    /* ========== 9. 对外接口 ========== */
    window.STAvatar = {
        setVideo: (charName, url) => {
            setVideoUrl(charName, url);
            initAll();
        },
        resetPos: (charName) => {
            setPos(charName, 0, 0);
            setScale(charName, MIN_SCALE);
            initAll();
        },
        listVideos: () => load(VIDEO_KEY),
        listPositions: () => load(POS_KEY),
        listScales: () => load(SCALE_KEY),
        refresh: initAll,
    };

    window.STAvatarPlugin = window.STAvatar;
})();
