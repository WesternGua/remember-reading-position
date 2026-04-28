const { Plugin, Notice, MarkdownView } = require('obsidian');

const SAVE_DELAY_MS = 500;
const MAX_SAVED_NOTES = 2000;
const OPEN_SCROLL_GUARD_MS = 2500;
const SEMANTIC_FINE_TUNE_DELAYS_MS = [0, 60, 180, 360, 700, 1100, 1600];
const LEGACY_RESTORE_DELAYS_MS = [0, 80, 180, 360, 700, 1100, 1600];
const LEGACY_PROMOTION_DELAY_MS = 1800;
const PROGRAMMATIC_SCROLL_GUARD_MS = 1000;
const SEMANTIC_EPSILON = 0.01;
const REVEAL_DELAY_MS = 1800;
const REVEAL_FALLBACK_MS = 2600;
const RESTORE_CHECK_INTERVAL_MS = 50;
const RESTORE_CHECK_TIMEOUT_MS = 2400;
const SEMANTIC_RESTORE_TOLERANCE = 0.35;
const PIXEL_RESTORE_TOLERANCE = 24;
const STARTUP_RESTORE_DELAY_MS = 80;
const TOP_OVERWRITE_GUARD_SEMANTIC = 1;
const TOP_OVERWRITE_GUARD_PIXEL = 50;
const RESTORING_CLASS = 'remember-reading-position-restoring';

class RememberReadingPositionPlugin extends Plugin {
  async onload() {
    this.store = this.normalizeStore(await this.loadData());
    this.leafStates = new Map();
    this.pendingTransitions = new WeakMap();
    this.suppressedScrollUntil = new WeakMap();
    this.revealTimeouts = new WeakMap();
    this.startupReady = false;
    this.unpatchers = [];
    this.timeoutIds = new Set();
    this.saveTimer = null;
    this.isSaving = false;
    this.needsResave = false;
    this.patchesInstalled = false;

    this.addCommand({
      id: 'forget-current-note-position',
      name: 'Forget saved scroll position for current note',
      callback: async () => {
        const leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
        const path = leaf?.view?.file?.path;
        if (!path) {
          new Notice('No active note.');
          return;
        }
        if (this.store.positions[path]) {
          delete this.store.positions[path];
          await this.persistData();
          new Notice('Saved scroll position cleared for current note.');
        } else {
          new Notice('No saved scroll position for current note.');
        }
      },
    });

    this.addCommand({
      id: 'forget-all-note-positions',
      name: 'Forget all saved scroll positions',
      callback: async () => {
        this.store.positions = {};
        await this.persistData();
        new Notice('All saved scroll positions cleared.');
      },
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      this.refreshLeafTracking();
    }));

    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.refreshLeafTracking();
    }));

    this.registerEvent(this.app.workspace.on('layout-change', () => {
      this.refreshLeafTracking();
    }));

    this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
      const oldEntry = this.store.positions[oldPath];
      if (!oldEntry) return;
      this.store.positions[file.path] = oldEntry;
      delete this.store.positions[oldPath];
      await this.persistData();
    }));

    this.registerEvent(this.app.vault.on('delete', async (file) => {
      if (!this.store.positions[file.path]) return;
      delete this.store.positions[file.path];
      await this.persistData();
    }));

    this.app.workspace.onLayoutReady(() => {
      this.installPatches();
      this.refreshLeafTracking();
      this.restoreOpenLeavesAfterStartup();
      this.scheduleManagedTimeout(() => {
        this.startupReady = true;
        this.saveAllOpenLeaves({ skipGuardedTop: true });
      }, OPEN_SCROLL_GUARD_MS);
    });
  }

  onunload() {
    this.saveAllOpenLeaves({ skipGuardedTop: true });

    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    for (const timeoutId of this.timeoutIds) {
      window.clearTimeout(timeoutId);
    }
    this.timeoutIds.clear();

    for (const [leaf] of this.leafStates) {
      this.clearHiddenUntilRestored(leaf);
      this.detachLeaf(leaf);
    }

    for (const unpatch of this.unpatchers.reverse()) {
      try {
        unpatch();
      } catch (_) {
        // noop
      }
    }
    this.unpatchers = [];

    void this.persistData();
  }

  installPatches() {
    if (this.patchesInstalled) return;

    const sampleLeaf = this.app.workspace.getMostRecentLeaf()
      || this.app.workspace.getLeavesOfType('markdown')[0]
      || this.app.workspace.getLeavesOfType('empty')[0];
    const sampleView = this.app.workspace.getActiveViewOfType(MarkdownView)
      || this.app.workspace.getLeavesOfType('markdown')[0]?.view;

    if (!sampleLeaf || !sampleView) return;

    const leafProto = Object.getPrototypeOf(sampleLeaf);
    const markdownViewProto = Object.getPrototypeOf(sampleView);

    this.unpatchers.push(this.patchMethod(leafProto, 'setViewState', (original, plugin) => {
      return function (...args) {
        const [viewState, eState] = args;
        const transition = plugin.prepareTransition(viewState, eState);

        if (transition) {
          plugin.pendingTransitions.set(this, transition);
          plugin.hideUntilRestored(this, transition);
          args[1] = transition.eState;
          plugin.scheduleTransitionCleanup(this, transition);
        }

        return original.apply(this, args);
      };
    }));

    this.unpatchers.push(this.patchMethod(markdownViewProto, 'onLoadFile', (original, plugin) => {
      return async function (...args) {
        const file = args[0];
        const result = await original.apply(this, args);
        plugin.handleViewLoadedFile(this, file);
        return result;
      };
    }));

    this.patchesInstalled = true;
  }

  patchMethod(target, methodName, buildPatched) {
    if (!target || typeof target[methodName] !== 'function') {
      return () => {};
    }

    const original = target[methodName];
    const plugin = this;
    const patched = buildPatched(original, plugin);

    target[methodName] = patched;

    return () => {
      if (target[methodName] === patched) {
        target[methodName] = original;
      }
    };
  }

  scheduleManagedTimeout(callback, delay) {
    const timeoutId = window.setTimeout(() => {
      this.timeoutIds.delete(timeoutId);
      callback();
    }, delay);

    this.timeoutIds.add(timeoutId);
    return timeoutId;
  }

  scheduleTransitionCleanup(leaf, transition) {
    if (transition.cleanupTimeoutId) {
      window.clearTimeout(transition.cleanupTimeoutId);
      this.timeoutIds.delete(transition.cleanupTimeoutId);
    }

    transition.cleanupTimeoutId = this.scheduleManagedTimeout(() => {
      if (this.pendingTransitions.get(leaf) === transition) {
        this.pendingTransitions.delete(leaf);
      }
    }, OPEN_SCROLL_GUARD_MS);
  }

  hideUntilRestored(leaf, transition) {
    if (!transition || transition.explicitNavigation || !transition.shouldHide) return;

    const contentEl = leaf?.view?.containerEl;
    if (!(contentEl instanceof HTMLElement)) return;

    contentEl.classList.add(RESTORING_CLASS);

    const existingTimeout = this.revealTimeouts.get(leaf);
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
      this.timeoutIds.delete(existingTimeout);
    }

    // Safety net only: normally we reveal after confirming the scroll is restored.
    // If Obsidian fails to report a stable scroll state, do not leave the note invisible forever.
    const timeoutId = this.scheduleManagedTimeout(() => {
      this.clearHiddenUntilRestored(leaf);
    }, transition.fallbackRevealAfter || REVEAL_FALLBACK_MS);
    this.revealTimeouts.set(leaf, timeoutId);
  }

  clearHiddenUntilRestored(leaf) {
    const timeoutId = this.revealTimeouts.get(leaf);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      this.timeoutIds.delete(timeoutId);
      this.revealTimeouts.delete(leaf);
    }

    const contentEl = leaf?.view?.containerEl;
    if (contentEl instanceof HTMLElement) {
      contentEl.classList.remove(RESTORING_CLASS);
    }
  }

  isTransitionRestored(leaf, transition) {
    const context = this.getLeafContext(leaf);
    if (!context || context.file.path !== transition.path) return false;

    if (Number.isFinite(transition.semanticScroll)) {
      const semantic = this.getSemanticScroll(context.view);
      return Number.isFinite(semantic) && Math.abs(semantic - transition.semanticScroll) <= SEMANTIC_RESTORE_TOLERANCE;
    }

    if (Number.isFinite(transition.legacyPixelScroll)) {
      return Math.abs(context.scrollEl.scrollTop - transition.legacyPixelScroll) <= PIXEL_RESTORE_TOLERANCE;
    }

    return true;
  }

  applyTransitionScroll(leaf, transition) {
    const context = this.getLeafContext(leaf);
    if (!context || context.file.path !== transition.path) return false;

    this.suppressedScrollUntil.set(context.scrollEl, Date.now() + PROGRAMMATIC_SCROLL_GUARD_MS);

    if (Number.isFinite(transition.semanticScroll)) {
      context.view.setEphemeralState({ scroll: transition.semanticScroll });
      return true;
    }

    if (Number.isFinite(transition.legacyPixelScroll)) {
      this.applyLegacyPixelScroll(context.scrollEl, transition.legacyPixelScroll);
      return true;
    }

    return false;
  }

  revealWhenRestored(leaf, transition, options = {}) {
    const startedAt = Date.now();
    const retry = options.retry !== false;

    const tick = () => {
      const current = this.pendingTransitions.get(leaf);
      if (current !== transition) {
        this.clearHiddenUntilRestored(leaf);
        return;
      }

      const context = this.getLeafContext(leaf);
      if (!context || context.file.path !== transition.path) {
        this.clearHiddenUntilRestored(leaf);
        return;
      }

      if (this.isTransitionRestored(leaf, transition)) {
        this.captureLeafPosition(leaf, { skipGuardedTop: true });
        this.clearHiddenUntilRestored(leaf);
        return;
      }

      if (retry) {
        this.applyTransitionScroll(leaf, transition);
      }

      if (Date.now() - startedAt >= (options.timeout ?? RESTORE_CHECK_TIMEOUT_MS)) {
        // Last attempt before falling back to visible; prevents a permanently blank note.
        this.applyTransitionScroll(leaf, transition);
        this.scheduleManagedTimeout(() => {
          this.captureLeafPosition(leaf, { skipGuardedTop: true });
          this.clearHiddenUntilRestored(leaf);
        }, 80);
        return;
      }

      this.scheduleManagedTimeout(tick, options.interval ?? RESTORE_CHECK_INTERVAL_MS);
    };

    tick();
  }

  restoreOpenLeavesAfterStartup() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      const path = view?.file?.path;
      if (!path) continue;

      const transition = this.prepareTransition({
        type: 'markdown',
        state: {
          file: path,
          mode: view?.getMode?.(),
        },
      }, {});

      if (!transition || transition.explicitNavigation || !transition.hasSavedPosition) continue;

      this.pendingTransitions.set(leaf, transition);
      this.hideUntilRestored(leaf, transition);
      this.scheduleTransitionCleanup(leaf, transition);
      this.applyTransitionToExistingView(leaf, transition);
    }
  }

  applyTransitionToExistingView(leaf, transition) {
    for (const delay of [0, STARTUP_RESTORE_DELAY_MS, 220, 500, 900, 1400]) {
      this.scheduleManagedTimeout(() => {
        const current = this.pendingTransitions.get(leaf);
        if (current !== transition) return;
        this.applyTransitionScroll(leaf, transition);
      }, delay);
    }

    this.scheduleManagedTimeout(() => {
      this.revealWhenRestored(leaf, transition, {
        timeout: RESTORE_CHECK_TIMEOUT_MS,
        interval: RESTORE_CHECK_INTERVAL_MS,
        retry: true,
      });
    }, STARTUP_RESTORE_DELAY_MS);
  }

  prepareTransition(viewState, eState) {
    const targetPath = viewState?.state?.file;
    if (viewState?.type !== 'markdown' || typeof targetPath !== 'string') {
      return null;
    }

    const targetMode = this.normalizeMode(viewState?.state?.mode);
    const baseEState = eState && typeof eState === 'object' ? { ...eState } : {};
    const explicitNavigation = this.hasExplicitNavigation(baseEState);
    const saved = explicitNavigation ? null : this.getSavedPosition(targetPath, targetMode);

    let injectedSemantic = false;
    if (!Object.prototype.hasOwnProperty.call(baseEState, 'scroll') && Number.isFinite(saved?.semanticScroll)) {
      baseEState.scroll = saved.semanticScroll;
      injectedSemantic = true;
    }

    const semanticScroll = Number.isFinite(saved?.semanticScroll) ? saved.semanticScroll : null;
    const legacyPixelScroll = !injectedSemantic && Number.isFinite(saved?.pixelScroll) ? saved.pixelScroll : null;
    const hasSavedPosition = Number.isFinite(semanticScroll) || Number.isFinite(legacyPixelScroll);

    return {
      path: targetPath,
      mode: targetMode,
      explicitNavigation,
      injectedSemantic,
      semanticScroll,
      legacyPixelScroll,
      hasSavedPosition,
      shouldHide: hasSavedPosition && !explicitNavigation,
      revealAfter: Number.isFinite(semanticScroll) ? REVEAL_DELAY_MS : LEGACY_PROMOTION_DELAY_MS,
      fallbackRevealAfter: REVEAL_FALLBACK_MS,
      ignoreScrollUntil: Date.now() + OPEN_SCROLL_GUARD_MS,
      eState: baseEState,
    };
  }

  hasExplicitNavigation(eState) {
    if (!eState || typeof eState !== 'object') return false;

    return [
      'scroll',
      'subpath',
      'line',
      'match',
      'propertyMatches',
      'rename',
      'startLoc',
      'endLoc',
    ].some((key) => Object.prototype.hasOwnProperty.call(eState, key));
  }

  handleViewLoadedFile(view, file) {
    if (!(view instanceof MarkdownView) || !file) return;

    const leaf = view.leaf;
    const transition = this.pendingTransitions.get(leaf);
    if (!transition || transition.path !== file.path) return;
    if (transition.explicitNavigation) return;

    this.refreshLeafTracking();

    if (transition.injectedSemantic && Number.isFinite(transition.semanticScroll)) {
      for (const delay of SEMANTIC_FINE_TUNE_DELAYS_MS) {
        this.scheduleManagedTimeout(() => {
          const current = this.pendingTransitions.get(leaf);
          if (current !== transition) return;
          this.applyTransitionScroll(leaf, transition);
        }, delay);
      }

      this.revealWhenRestored(leaf, transition, {
        timeout: RESTORE_CHECK_TIMEOUT_MS,
        interval: RESTORE_CHECK_INTERVAL_MS,
        retry: true,
      });
      return;
    }

    if (!Number.isFinite(transition.legacyPixelScroll)) {
      this.clearHiddenUntilRestored(leaf);
      return;
    }

    for (const delay of LEGACY_RESTORE_DELAYS_MS) {
      this.scheduleManagedTimeout(() => {
        const current = this.pendingTransitions.get(leaf);
        if (current !== transition) return;
        this.applyTransitionScroll(leaf, transition);
      }, delay);
    }

    this.revealWhenRestored(leaf, transition, {
      timeout: RESTORE_CHECK_TIMEOUT_MS,
      interval: RESTORE_CHECK_INTERVAL_MS,
      retry: true,
    });
  }

  applyLegacyPixelScroll(scrollEl, pixelScroll) {
    if (!(scrollEl instanceof HTMLElement) || !Number.isFinite(pixelScroll)) return;

    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    const target = Math.max(0, Math.min(Math.round(pixelScroll), maxScrollTop || Math.round(pixelScroll)));

    this.suppressedScrollUntil.set(scrollEl, Date.now() + PROGRAMMATIC_SCROLL_GUARD_MS);
    scrollEl.scrollTop = target;
  }

  normalizeStore(data) {
    const store = data && typeof data === 'object' ? data : {};
    const positions = store.positions && typeof store.positions === 'object' ? store.positions : {};

    for (const [path, entry] of Object.entries(positions)) {
      if (typeof entry === 'number') {
        positions[path] = {
          updatedAt: Date.now(),
          lastMode: 'default',
          modes: {
            default: {
              pixelScroll: Math.max(0, entry),
              updatedAt: Date.now(),
            },
          },
        };
        continue;
      }

      if (!entry || typeof entry !== 'object') {
        delete positions[path];
        continue;
      }

      const modes = entry.modes && typeof entry.modes === 'object' ? entry.modes : {};
      const cleanedModes = {};

      for (const [mode, modeEntry] of Object.entries(modes)) {
        const semanticScroll = Number(modeEntry?.semanticScroll);
        const pixelScroll = Number(modeEntry?.pixelScroll ?? modeEntry?.scrollTop);

        if (!Number.isFinite(semanticScroll) && !Number.isFinite(pixelScroll)) continue;

        cleanedModes[this.normalizeMode(mode)] = {
          ...(Number.isFinite(semanticScroll) ? { semanticScroll: Math.max(0, semanticScroll) } : {}),
          ...(Number.isFinite(pixelScroll) ? { pixelScroll: Math.max(0, pixelScroll) } : {}),
          updatedAt: Number(modeEntry?.updatedAt) || Date.now(),
        };
      }

      const fallbackSemantic = Number(entry.semanticScroll);
      const fallbackPixel = Number(entry.pixelScroll ?? entry.scrollTop);
      if (
        Object.keys(cleanedModes).length === 0
        && (Number.isFinite(fallbackSemantic) || Number.isFinite(fallbackPixel))
      ) {
        cleanedModes.default = {
          ...(Number.isFinite(fallbackSemantic) ? { semanticScroll: Math.max(0, fallbackSemantic) } : {}),
          ...(Number.isFinite(fallbackPixel) ? { pixelScroll: Math.max(0, fallbackPixel) } : {}),
          updatedAt: Number(entry.updatedAt) || Date.now(),
        };
      }

      if (Object.keys(cleanedModes).length === 0) {
        delete positions[path];
        continue;
      }

      positions[path] = {
        updatedAt: Number(entry.updatedAt) || Date.now(),
        lastMode: this.normalizeMode(entry.lastMode),
        modes: cleanedModes,
      };
    }

    return {
      version: 2,
      positions,
    };
  }

  normalizeMode(mode) {
    return mode === 'preview' ? 'preview' : mode === 'source' ? 'source' : 'default';
  }

  refreshLeafTracking() {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    const currentLeaves = new Set(leaves);

    for (const [leaf] of this.leafStates) {
      if (!currentLeaves.has(leaf)) {
        this.detachLeaf(leaf);
      }
    }

    for (const leaf of leaves) {
      this.ensureLeafTracked(leaf);
    }
  }

  ensureLeafTracked(leaf) {
    const context = this.getLeafContext(leaf);
    const existing = this.leafStates.get(leaf);

    if (!context) {
      if (existing) this.detachLeaf(leaf);
      return;
    }

    if (existing && existing.scrollEl === context.scrollEl) {
      existing.filePath = context.file.path;
      existing.mode = context.mode;
      return;
    }

    if (existing) {
      this.detachLeaf(leaf);
    }

    const onScroll = (event) => this.handleScroll(leaf, event);
    context.scrollEl.addEventListener('scroll', onScroll, { passive: true });

    this.leafStates.set(leaf, {
      scrollEl: context.scrollEl,
      onScroll,
      filePath: context.file.path,
      mode: context.mode,
    });
  }

  detachLeaf(leaf) {
    const state = this.leafStates.get(leaf);
    if (!state) return;

    if (state.scrollEl && state.onScroll) {
      state.scrollEl.removeEventListener('scroll', state.onScroll);
    }

    this.leafStates.delete(leaf);
  }

  getLeafContext(leaf) {
    if (!leaf?.view || leaf.view.getViewType?.() !== 'markdown') return null;
    if (!(leaf.view instanceof MarkdownView)) return null;
    if (!leaf.view.file) return null;

    const scrollEl = this.findScrollElement(leaf.view);
    if (!scrollEl) return null;

    return {
      view: leaf.view,
      file: leaf.view.file,
      scrollEl,
      mode: this.getModeKey(leaf.view, scrollEl),
    };
  }

  findScrollElement(view) {
    if (view?.getMode?.() === 'source' && view.currentMode?.cm?.scrollDOM instanceof HTMLElement) {
      return view.currentMode.cm.scrollDOM;
    }

    const previewRenderer = view?.previewMode?.renderer;
    const previewCandidates = [
      previewRenderer?.previewEl,
      previewRenderer?.containerEl,
      view?.containerEl?.querySelector('.markdown-preview-view'),
    ];
    for (const candidate of previewCandidates) {
      if (candidate instanceof HTMLElement) return candidate;
    }

    const container = view?.containerEl;
    if (!container) return null;

    const candidates = [
      container.querySelector('.cm-scroller'),
      container.querySelector('.markdown-preview-view'),
      container.querySelector('.view-content'),
      view.contentEl,
    ].filter((element, index, array) => element instanceof HTMLElement && array.indexOf(element) === index);

    return candidates[0] || null;
  }

  getModeKey(view, scrollEl) {
    const viewMode = this.normalizeMode(view?.getMode?.());
    if (viewMode !== 'default') return viewMode;
    if (scrollEl?.classList?.contains('cm-scroller')) return 'source';
    if (scrollEl?.classList?.contains('markdown-preview-view')) return 'preview';
    return 'default';
  }

  getSemanticScroll(view) {
    const currentModeScroll = Number(view?.currentMode?.getScroll?.());
    if (Number.isFinite(currentModeScroll)) return Math.max(0, currentModeScroll);

    const ephemeralScroll = Number(view?.getEphemeralState?.()?.scroll);
    if (Number.isFinite(ephemeralScroll)) return Math.max(0, ephemeralScroll);

    const ownScroll = Number(view?.scroll);
    if (Number.isFinite(ownScroll)) return Math.max(0, ownScroll);

    return null;
  }

  handleScroll(leaf, event) {
    const scrollEl = event.currentTarget;
    if (!(scrollEl instanceof HTMLElement)) return;

    const view = leaf?.view;
    const file = view?.file;
    if (!file) return;

    const transition = this.pendingTransitions.get(leaf);
    if (transition && transition.path === file.path && Date.now() < transition.ignoreScrollUntil) {
      return;
    }

    const suppressedUntil = this.suppressedScrollUntil.get(scrollEl) || 0;
    if (Date.now() < suppressedUntil) return;

    const semanticScroll = this.getSemanticScroll(view);
    const pixelScroll = Math.max(0, Math.round(scrollEl.scrollTop));
    const mode = this.getModeKey(view, scrollEl);

    this.storePosition(file.path, mode, { semanticScroll, pixelScroll }, { skipGuardedTop: !this.startupReady });

    const state = this.leafStates.get(leaf);
    if (state) {
      state.filePath = file.path;
      state.mode = mode;
    }
  }

  captureLeafPosition(leaf, options = {}) {
    const context = this.getLeafContext(leaf);
    if (!context) return false;

    const semanticScroll = this.getSemanticScroll(context.view);
    const pixelScroll = Math.max(0, Math.round(context.scrollEl.scrollTop));

    return this.storePosition(context.file.path, context.mode, { semanticScroll, pixelScroll }, options);
  }

  storePosition(path, mode, position, options = {}) {
    const now = Date.now();
    const normalizedMode = this.normalizeMode(mode);
    const semanticScroll = Number(position?.semanticScroll);
    const pixelScroll = Number(position?.pixelScroll);
    const existing = this.store.positions[path] || { updatedAt: now, lastMode: normalizedMode, modes: {} };
    const previous = existing.modes?.[normalizedMode] || {};

    if (options.skipGuardedTop && this.isSuspiciousTopOverwrite(previous, semanticScroll, pixelScroll)) {
      return false;
    }

    const nextModeEntry = {
      ...(Number.isFinite(semanticScroll) ? { semanticScroll: Math.max(0, semanticScroll) } : previous.semanticScroll != null ? { semanticScroll: previous.semanticScroll } : {}),
      ...(Number.isFinite(pixelScroll) ? { pixelScroll: Math.max(0, pixelScroll) } : previous.pixelScroll != null ? { pixelScroll: previous.pixelScroll } : {}),
      updatedAt: now,
    };

    const semanticChanged = Number.isFinite(nextModeEntry.semanticScroll)
      ? !Number.isFinite(previous.semanticScroll) || Math.abs(previous.semanticScroll - nextModeEntry.semanticScroll) > SEMANTIC_EPSILON
      : false;

    const pixelChanged = Number.isFinite(nextModeEntry.pixelScroll)
      ? !Number.isFinite(previous.pixelScroll) || Math.abs(previous.pixelScroll - nextModeEntry.pixelScroll) >= 1
      : false;

    existing.updatedAt = now;
    existing.lastMode = normalizedMode;
    existing.modes = existing.modes || {};
    existing.modes[normalizedMode] = nextModeEntry;
    this.store.positions[path] = existing;

    if (semanticChanged || pixelChanged) {
      this.prunePositions();
      this.queueSave();
    }

    return semanticChanged || pixelChanged;
  }

  isSuspiciousTopOverwrite(previous, semanticScroll, pixelScroll) {
    if (!previous) return false;

    const hadRealSemantic = Number.isFinite(previous.semanticScroll) && previous.semanticScroll > TOP_OVERWRITE_GUARD_SEMANTIC;
    const nextAtTopSemantic = Number.isFinite(semanticScroll) && semanticScroll <= TOP_OVERWRITE_GUARD_SEMANTIC;
    const hadRealPixel = Number.isFinite(previous.pixelScroll) && previous.pixelScroll > TOP_OVERWRITE_GUARD_PIXEL;
    const nextAtTopPixel = Number.isFinite(pixelScroll) && pixelScroll <= TOP_OVERWRITE_GUARD_PIXEL;

    return (hadRealSemantic && nextAtTopSemantic) || (hadRealPixel && nextAtTopPixel);
  }

  getSavedPosition(path, mode) {
    const entry = this.store.positions[path];
    if (!entry || !entry.modes) return null;

    const normalizedMode = this.normalizeMode(mode);
    return entry.modes[normalizedMode]
      || entry.modes[entry.lastMode]
      || Object.values(entry.modes)[0]
      || null;
  }

  saveAllOpenLeaves(options = {}) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      this.captureLeafPosition(leaf, options);
    }
  }

  prunePositions() {
    const entries = Object.entries(this.store.positions);
    if (entries.length <= MAX_SAVED_NOTES) return;

    entries.sort((a, b) => (a[1]?.updatedAt || 0) - (b[1]?.updatedAt || 0));
    const overflow = entries.length - MAX_SAVED_NOTES;

    for (let index = 0; index < overflow; index += 1) {
      delete this.store.positions[entries[index][0]];
    }
  }

  queueSave() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
    }

    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.persistData();
    }, SAVE_DELAY_MS);
  }

  async persistData() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.isSaving) {
      this.needsResave = true;
      return;
    }

    this.isSaving = true;
    try {
      await this.saveData(this.store);
    } finally {
      this.isSaving = false;
      if (this.needsResave) {
        this.needsResave = false;
        await this.persistData();
      }
    }
  }
}

module.exports = RememberReadingPositionPlugin;
