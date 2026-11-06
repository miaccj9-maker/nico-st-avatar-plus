# ST Avatar Drag & Video（SillyTavern 扩展）

酒馆头像：动态视频支持 + 双击编辑模式。从 Tampermonkey 用户脚本移植，装好后不再需要油猴，开关在「扩展」面板里控制。

## 为什么是双击

头像就在消息旁边，单手滑动聊天列表时很容易蹭到，老版本会直接跟着拖走、误触缩放。现在：

- **默认锁定**：单指滑、滚轮、单击全都不动画面，滑动页面该怎么滑还怎么滑；
- **双击头像**（手机双击轻点）才进入编辑模式，头像描一圈蓝边表示"可拖动"；
- 编辑模式内：拖动平移、滚轮 / 双指捏合缩放；
- **再次双击 / 点空白处 / 按 Esc** 退出，回到锁定状态。

## 功能

- **视频动态头像**：每个角色可把静态头像换成 mp4 / webm（也支持 gif、png、jpg、webp）。
- **画幅自适应**：按媒体真实分辨率推算渲染尺寸，不被裁成一条缝，不放大也能拖遍整张画面。
- **零黑边锁边**：绝对边界吸附，任意缩放比例下都填满原生头像框，不脱框、不露黑。
- **分存档隔离**：设置绑定「当前聊天存档 + 角色」，不同存档互不干扰。
- **兼容主题**：只改内联样式与容器裁切，不动主题的边框、圆角、阴影。
- **本地文件直存**：选本地视频存进 IndexedDB，刷新、重启后仍在，不需要图床。

## 操作

| 操作 | 锁定状态 | 编辑模式 |
| --- | --- | --- |
| 双击 / 双击轻点 | 进入编辑模式 | 退出编辑模式 |
| 单指 / 鼠标拖动 | 不响应（正常滑动页面） | 平移画面 |
| 滚轮 / 双指捏合 | 不响应（正常滚动页面） | 缩放 1.0× ~ 4.5× |
| 右键 / 长按 | 打开头像设置弹窗 | 打开头像设置弹窗 |
| Esc / 点空白处 | — | 退出编辑模式 |

设置弹窗里三选一：网络直链、本地文件、复位（清空视频与位移）。

## 安装

**方式一：从 GitHub 装**

扩展面板 → 安装扩展 → 输入：

```
https://github.com/miaccj9-maker/nico-st-avatar-plus
```

**方式二：手动放文件夹**

```
SillyTavern/public/scripts/extensions/third-party/nico-st-avatar-plus/
├── manifest.json
├── index.js
├── style.css
├── LICENSE
└── README.md
```

放好后重启酒馆或刷新页面，扩展面板里打开「ST Avatar Drag & Video」开关。

## 数据位置（如需清空）

- `localStorage.st_avatar_video_urls` — 视频直链
- `localStorage.st_avatar_positions` — 平移位置
- `localStorage.st_avatar_scales` — 缩放比例
- IndexedDB `ST_Avatar_Local_DB` / store `avatar_files` — 本地文件二进制

```js
indexedDB.deleteDatabase('ST_Avatar_Local_DB');
['st_avatar_video_urls', 'st_avatar_positions', 'st_avatar_scales']
    .forEach(k => localStorage.removeItem(k));
```

## 控制台接口

```js
STAvatar.setVideo('角色名', 'https://example.com/a.mp4'); // 设置视频
STAvatar.resetPos('角色名');                              // 复位位移与缩放
STAvatar.listVideos();                                    // 查看全部配置
STAvatar.refresh();                                       // 重新挂载
```

## 版本

- **1.4.0** 双击编辑模式：默认锁定防误触；退出方式为再次双击 / 点空白 / Esc；考点空白与 Esc 的全局守卫。
- **1.3.0** 分存档隔离、零抖动锁边。

## 已知限制

- 网络直链需允许跨域（CORS），否则可能加载失败；本地文件不受此限。
- 只处理 `#chat` 里的消息头像，角色列表、群成员面板的头像不在范围内。
- 手机端长按可能仍弹出系统「保存图片」菜单，扩展已拦截 `contextmenu`，个别内核拦不住可忽略。
