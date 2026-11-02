// ==UserScript==
// @name         SillyTavern 头像拖拽 + 视频动态头像（画幅自适应全览+零黑边锁边+超清原画版）
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  彻底解决画面裁切与脱框露黑：动态映射真实物理渲染画幅，未放大亦可平移滑遍全图；绝对边界吸附算法，无论何种缩放比例均杜绝黑边；超清硬件加速无损锐化引擎，告别亚像素模糊与画质损耗；完全兼容酒馆所有主题CSS头像框。
// @author       nico2
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @match        https://*/sillytavern*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    /* ========== 存储键名 ========== */
    const VIDEO_KEY = 'st_avatar_video_urls';
    const POS_KEY = 'st_avatar_positions';
    const SCALE_KEY = 'st_avatar_scales';
    const DB_NAME = 'ST_Avatar_Local_DB';
    const DB_STORE = 'avatar_files';

    /* ========== 1. IndexedDB 异步二进制存储 (原画原盘存储无损) ========== */
    let dbPromise = null;
    function getDB() {
        if (!dbPromise) {
          dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, 1);
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

    async function saveLocalFile(name, fileBlob) {
        try {
          const db = await getDB();
          return new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put(fileBlob, name);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
          });
        } catch (e) {
          return false;
        }
    }

    async function getLocalFile(name) {
        try {
          const db = await getDB();
          return new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readonly');
          const req = tx.objectStore(DB_STORE).get(name);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
          });
        } catch (e) {
          return null;
        }
    }

    async function deleteLocalFile(name) {
        try {
          const db = await getDB();
          return new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).delete(name);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
          });
        } catch (e) {
          return false;
        }
    }

    /* ========== 2. 状态读写 ========== */
    const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } };
    const save = (k, d) => localStorage.setItem(k, JSON.stringify(d));

    const getVideoUrl = (name) => load(VIDEO_KEY)[name] || '';
    const setVideoUrl = (name, url) => {
        const d = load(VIDEO_KEY);
        if (url) d[name] = url; else delete d[name];
        save(VIDEO_KEY, d);
    };

    const getPos = (name) => load(POS_KEY)[name] || { x: 0, y: 0 };
    const setPos = (name, x, y) => {
        const d = load(POS_KEY);
        d[name] = { x: Math.round(x), y: Math.round(y) };
        save(POS_KEY, d);
    };

    const getScale = (name) => load(SCALE_KEY)[name] || 1.0;
    const setScale = (name, s) => {
        const d = load(SCALE_KEY);
        if (s && s > 1.0) d[name] = s; else delete d[name];
        save(SCALE_KEY, d);
    };

    const activeBlobUrls = new Map();

    async function resolveAvatarSource(charName) {
        const localBlob = await getLocalFile(charName);
        if (localBlob) {
          if (activeBlobUrls.has(charName)) {
          URL.revokeObjectURL(activeBlobUrls.get(charName));
          }
          const blobUrl = URL.createObjectURL(localBlob);
          activeBlobUrls.set(charName, blobUrl);
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
          if (av.tagName === 'IMG' || av.tagName === 'VIDEO') return { el: av, mode: 'object', container: av.parentElement || av };
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
        modalHost.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483000;pointer-events:none;';
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
          • 原画无损渲染：物理整数像素精准对齐，告别模糊掉帧<br>
          • 未放大亦可平移超出部分，头部画面不再被强行裁剪<br>
          • 滚轮/双指平滑缩放；动态锁边算法杜绝黑边
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
          setPos(name, 0, 0);
          setScale(name, 1.0);
          setVideoUrl(name, '');
          await deleteLocalFile(name);
          if (activeBlobUrls.has(name)) {
          URL.revokeObjectURL(activeBlobUrls.get(name));
          activeBlobUrls.delete(name);
          }
          initAll();
          close({ reset: true });
        });

        cancelBtn.addEventListener('click', () => close({ cancel: true }));

        okBtn.addEventListener('click', async () => {
          const name = modalHost.dataset.charName;
          const textUrl = input.value.trim();

          if (pendingFileBlob) {
          await saveLocalFile(name, pendingFileBlob);
          setVideoUrl(name, '');
          } else if (textUrl) {
          await deleteLocalFile(name);
          if (activeBlobUrls.has(name)) {
          URL.revokeObjectURL(activeBlobUrls.get(name));
          activeBlobUrls.delete(name);
          }
          setVideoUrl(name, textUrl);
          } else {
          await deleteLocalFile(name);
          if (activeBlobUrls.has(name)) {
          URL.revokeObjectURL(activeBlobUrls.get(name));
          activeBlobUrls.delete(name);
          }
          setVideoUrl(name, '');
          }

          initAll();
          close({ ok: true });
        });

        overlay.addEventListener('click', (e) => { if (e.target === overlay) close({ cancel: true }); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') okBtn.click(); });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && modalHost.style.display !== 'none') close({ cancel: true });
        });

        return modalHost;
    }

    async function openVideoModal(charName) {
        ensureModal();
        const shadow = modalHost.shadowRoot;
        modalHost.dataset.charName = charName;
        shadow.getElementById('title').textContent = '【' + charName + '】头像设置';
        shadow.getElementById('input').value = getVideoUrl(charName);
        pendingFileBlob = null;

        const hasLocal = await getLocalFile(charName);
        const statusTip = shadow.getElementById('statusTip');
        if (hasLocal) {
          statusTip.textContent = `当前使用本地存储 (${(hasLocal.size / (1024 * 1024)).toFixed(1)} MB)`;
          statusTip.style.display = 'block';
        } else {
          statusTip.style.display = 'none';
        }

        modalHost.style.display = 'block';
        setTimeout(() => shadow.getElementById('input').focus(), 100);
        return new Promise((resolve) => { modalResolve = resolve; });
    }

    /* ========== 5. 核心：自适应画幅物理覆盖 + 硬件加速锁边引擎 ========== */
    function setupDrag(target, charName) {
        const el = target.el, mode = target.mode, container = target.container;
        if (el.dataset.dragReady) return;
        el.dataset.dragReady = '1';

        if (container) {
          container.style.overflow = 'hidden';
          if (getComputedStyle(container).position === 'static') {
          container.style.position = 'relative';
          }
        }

        // 注入超清锐化与硬件加速滤镜，杜绝重排卡顿
        if (mode !== 'background') {
          el.style.imageRendering = '-webkit-optimize-contrast';
          el.style.imageRendering = 'high-quality';
          el.style.backfaceVisibility = 'hidden';
          el.style.webkitBackfaceVisibility = 'hidden';
          el.style.transformStyle = 'preserve-3d';
          el.style.willChange = 'transform';
        }

        let pos = getPos(charName);
        let scale = Math.max(1.0, getScale(charName));
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
          return { renderW: Math.ceil(renderW), renderH: Math.ceil(renderH) };
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
          y: clampVal(y, -maxY, maxY)
          };
        };

        const applyTransform = (x, y, s) => {
          if (!container) return;
          const rect = container.getBoundingClientRect();
          const boxW = rect.width || container.offsetWidth || 60;
          const boxH = rect.height || container.offsetHeight || 60;

          const { renderW, renderH } = getRenderDimensions(boxW, boxH);
          const safe = clampSafePosition(x, y, s);
          
          // 锁死整数像素位移，彻底消除因亚像素引起的图元模糊
          pos.x = Math.round(safe.x);
          pos.y = Math.round(safe.y);
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

        const schedule = (x, y, s) => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
          raf = 0;
          applyTransform(x, y, s);
          });
        };

        const resetPos = () => {
          applyTransform(0, 0, 1.0);
          setPos(charName, 0, 0);
          setScale(charName, 1.0);
        };

        if (el.tagName === 'IMG') {
          if (!el.complete) {
          el.addEventListener('load', () => applyTransform(pos.x, pos.y, scale), { once: true });
          }
        } else if (el.tagName === 'VIDEO') {
          if (el.readyState < 1) {
          el.addEventListener('loadedmetadata', () => applyTransform(pos.x, pos.y, scale), { once: true });
          }
        }

        applyTransform(pos.x, pos.y, scale);

        el.style.cursor = 'grab';
        el.style.userSelect = 'none';
        el.style.webkitUserDrag = 'none';
        if (mode !== 'background') el.style.touchAction = 'none';

        /* 桌面端：滚轮缩放 */
        el.addEventListener('wheel', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const step = e.deltaY < 0 ? 0.15 : -0.15;
          const newScale = clampVal(Math.round((scale + step) * 100) / 100, 1.0, 4.5);
          schedule(pos.x, pos.y, newScale);
          setScale(charName, newScale);
        }, { passive: false });

        /* 桌面端：鼠标平移 */
        let mDrag = false, mLastX = 0, mLastY = 0;
        const mDown = (e) => {
          if (e.button !== 0) return;
          mDrag = true;
          mLastX = e.clientX;
          mLastY = e.clientY;
          el.style.cursor = 'grabbing';
          e.preventDefault();
          e.stopPropagation();
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
          if (mDrag) {
          mDrag = false;
          el.style.cursor = 'grab';
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          const safe = clampSafePosition(pos.x, pos.y, scale);
          setPos(charName, safe.x, safe.y);
          }
        };

        el.addEventListener('mousedown', mDown);
        document.addEventListener('mousemove', mMove);
        document.addEventListener('mouseup', mUp);
        el.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); resetPos(); });

        /* 移动端：双指缩放 + 单指拖拽 */
        const DRAG_THRESHOLD = 5;
        const DBL_TAP_MS = 320;
        let tActive = false, tDrag = false, tPinch = false, tConsumed = false;
        let tStartX = 0, tStartY = 0, tLastX = 0, tLastY = 0, lastTapT = 0;
        let pinchStartDist = 0, pinchStartScale = 1;

        const getTouchDist = (touches) => Math.hypot(
          touches[0].clientX - touches[1].clientX,
          touches[0].clientY - touches[1].clientY
        );

        const tStart = (e) => {
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
          tStartX = t.clientX; tStartY = t.clientY;
          tLastX = t.clientX; tLastY = t.clientY;
          tActive = true; tDrag = false; tPinch = false; tConsumed = false;
          }
        };

        const tMove = (e) => {
          if (!tActive) return;

          if (e.touches.length === 2) {
          e.preventDefault();
          const dist = getTouchDist(e.touches);
          if (pinchStartDist > 0) {
          const factor = dist / pinchStartDist;
          const newScale = clampVal(Math.round((pinchStartScale * factor) * 100) / 100, 1.0, 4.5);
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
          } else return;
          }

          e.preventDefault();
          const dx = t.clientX - tLastX;
          const dy = t.clientY - tLastY;
          schedule(pos.x + dx, pos.y + dy, scale);
          tLastX = t.clientX;
          tLastY = t.clientY;
        };

        const tEnd = (e) => {
          if (!tActive) return;

          if (tPinch && e.touches.length < 2) {
          tPinch = false;
          setScale(charName, scale);
          }

          if (e.touches.length === 0) {
          tActive = false;
          el.style.cursor = 'grab';

          if (tConsumed) { tConsumed = false; return; }

          if (tDrag) {
          tDrag = false;
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          const safe = clampSafePosition(pos.x, pos.y, scale);
          setPos(charName, safe.x, safe.y);
          return;
          }

          const now = Date.now();
          if (now - lastTapT < DBL_TAP_MS) {
          lastTapT = 0;
          resetPos();
          } else {
          lastTapT = now;
          }
          }
        };

        const tCancel = () => { tActive = false; tDrag = false; tPinch = false; tConsumed = false; };

        el.addEventListener('touchstart', tStart, { passive: true });
        el.addEventListener('touchmove', tMove, { passive: false });
        el.addEventListener('touchend', tEnd, { passive: true });
        el.addEventListener('touchcancel', tCancel, { passive: true });

        /* 唤醒面板 */
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const isLongPress = tActive;
          if (isLongPress) tConsumed = true;
          openVideoModal(charName);
        });
    }

    /* ========== 6. 介质挂载与无损替换 ========== */
    async function applyAvatar(mes) {
        if (!mes) return;
        const charName = getCharName(mes);
        const t = findAvatar(mes);
        if (!t || t.mode !== 'object') return;

        const container = t.container;
        const mediaSource = await resolveAvatarSource(charName);
        const existingImg = container.querySelector('img');
        const existingVideo = container.querySelector('video');

        const isVideo = (info) => {
          if (!info || !info.src) return false;
          if (info.type && info.type.startsWith('video/')) return true;
          return /\.(mp4|webm)($|\?)/i.test(info.src);
        };

        if (mediaSource && mediaSource.src) {
          if (isVideo(mediaSource)) {
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
          video.disablePictureInPicture = true;
          video.className = existingImg.className;
          video.style.cssText = existingImg.style.cssText;
          container.replaceChild(video, existingImg);
          setupDrag({ el: video, mode: 'object', container }, charName);
          video.play().catch(() => {});
          } else if (existingVideo && existingVideo.src !== mediaSource.src) {
          existingVideo.src = mediaSource.src;
          existingVideo.load();
          existingVideo.play().catch(() => {});
          }
          } else {
          if (existingVideo) {
          const img = document.createElement('img');
          img.className = existingVideo.className;
          img.style.cssText = existingVideo.style.cssText;
          img.src = mediaSource.src;
          img.decoding = 'async';
          container.replaceChild(img, existingVideo);
          setupDrag({ el: img, mode: 'object', container }, charName);
          } else if (existingImg) {
          if (!container.dataset.origSrc) container.dataset.origSrc = existingImg.src;
          if (existingImg.src !== mediaSource.src) existingImg.src = mediaSource.src;
          existingImg.decoding = 'async';
          setupDrag({ el: existingImg, mode: 'object', container }, charName);
          }
          }
        } else {
          if (existingVideo) {
          const img = document.createElement('img');
          img.className = existingVideo.className;
          img.style.cssText = existingVideo.style.cssText;
          img.src = container.dataset.origSrc || existingVideo.getAttribute('data-orig-src') || '';
          img.decoding = 'async';
          container.replaceChild(img, existingVideo);
          setupDrag({ el: img, mode: 'object', container }, charName);
          } else if (existingImg && container.dataset.origSrc) {
          existingImg.src = container.dataset.origSrc;
          delete container.dataset.origSrc;
          existingImg.decoding = 'async';
          setupDrag({ el: existingImg, mode: 'object', container }, charName);
          }
        }
    }

    /* ========== 7. 批量挂载与监听 ========== */
    function initAll() {
        document.querySelectorAll('#chat .mes').forEach((mes) => {
          const t = findAvatar(mes);
          if (t) setupDrag(t, getCharName(mes));
          applyAvatar(mes);
        });
    }

    const observer = new MutationObserver((muts) => {
        for (const m of muts) {
          m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          const targets = node.classList?.contains('mes') ? [node] : (node.querySelectorAll?.('.mes') || []);
          targets.forEach((mes) => {
          const t = findAvatar(mes);
          if (t) setupDrag(t, getCharName(mes));
          applyAvatar(mes);
          });
          });
        }
    });

    function start() {
        initAll();
        const chat = document.getElementById('chat');
        if (chat) observer.observe(chat, { childList: true, subtree: true });
        console.log('%c[ST Avatar+] 1.3.0 超清画质无损锁边引擎就绪', 'color:#4a90e2;font-weight:bold');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    /* ========== 对外接口 ========== */
    window.STAvatar = {
        setVideo: (charName, url) => { setVideoUrl(charName, url); initAll(); },
        resetPos: (charName) => { setPos(charName, 0, 0); setScale(charName, 1.0); initAll(); },
        listVideos: () => load(VIDEO_KEY),
        listPositions: () => load(POS_KEY),
        listScales: () => load(SCALE_KEY),
        refresh: initAll
    };
})();