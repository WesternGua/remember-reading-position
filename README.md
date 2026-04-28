# Remember Reading Position

一个 Obsidian 插件，自动记住并恢复每篇笔记的滚动位置。在笔记之间切换时不会丢失阅读进度。

## 功能

- **自动保存和恢复** — 阅读时自动保存滚动位置，重新打开笔记时自动恢复。
- **分模式记录** — 源码模式和阅读模式分别记录位置，互不干扰。
- **语义 + 像素滚动** — 优先使用 Obsidian 的语义滚动 API，像素级滚动作为后备方案。
- **平滑体验** — 恢复位置时短暂隐藏笔记内容，**彻底避免"闪到顶部"的视觉跳动**。经实测对比同类插件（如 Remember cursor position），本插件在切换笔记时无闪烁，体验更流畅。
- **处理重命名和删除** — 文件重命名时位置自动跟随，删除时自动清理。
- **轻量无配置** — 开箱即用，无需任何设置。

## 命令

| 命令 | 说明 |
|------|------|
| **Forget saved scroll position for current note** | 清除当前笔记的保存位置 |
| **Forget all saved scroll positions** | 清除所有笔记的保存位置 |

## 安装

### 手动安装

1. 从 [最新 Release](https://github.com/WesternGua/remember-reading-position/releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 在 Vault 的 `.obsidian/plugins/` 目录下创建 `remember-reading-position` 文件夹。
3. 将下载的文件放入该文件夹。
4. 重启 Obsidian，在 **设置 → 第三方插件** 中启用该插件。

## 工作原理

插件监听每个打开的 Markdown 页面的滚动事件，按笔记和模式（源码/预览）将位置存储在 `data.json` 中。打开笔记时，插件在 Obsidian 渲染视图之前注入保存的滚动偏移量，并在内容加载完成后微调位置。

最多保存 2,000 条笔记的位置记录，最旧的条目会被自动清理。

## 兼容性

- ✅ **macOS** — 开发和测试环境，完整支持。
- ⚠️ **Windows / Linux** — 未经测试，不保证能完美运行。如遇问题欢迎提 Issue。

---

# Remember Reading Position (English)

An Obsidian plugin that automatically remembers and restores the last scroll position for each note. Switch between notes without losing your place.

## Features

- **Automatic save & restore** — scroll positions are saved as you read and restored when you reopen a note.
- **Per-mode tracking** — separate positions for Source mode and Reading mode, no interference.
- **Semantic + pixel scrolling** — uses Obsidian's semantic scroll API when available, with pixel-based fallback for reliability.
- **Smooth experience** — hides the note body briefly during restore to **completely eliminate the "flash to top" visual jump**. Compared side-by-side with similar plugins (e.g. Remember cursor position), this plugin provides a noticeably smoother experience when switching notes.
- **Handles renames & deletes** — saved positions follow file renames and are cleaned up on deletion.
- **Lightweight** — no settings UI needed; works out of the box.

## Commands

| Command | Description |
|---------|-------------|
| **Forget saved scroll position for current note** | Clears the saved position for the active note |
| **Forget all saved scroll positions** | Clears all saved positions across the vault |

## Installation

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/WesternGua/remember-reading-position/releases/latest).
2. Create a folder `remember-reading-position` inside your vault's `.obsidian/plugins/` directory.
3. Place the downloaded files into that folder.
4. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## How It Works

The plugin listens to scroll events on every open Markdown leaf. Positions are stored per-note and per-mode (source / preview) in `data.json`. When a note is opened, the plugin patches `setViewState` to inject the saved scroll offset before Obsidian renders the view, then fine-tunes the position after the content loads.

A maximum of 2,000 note positions are kept. The oldest entries are pruned automatically.

## Compatibility

- ✅ **macOS** — Developed and tested. Fully supported.
- ⚠️ **Windows / Linux** — Not tested. May not work perfectly. Issues and PRs are welcome.

## License

[MIT](LICENSE)
