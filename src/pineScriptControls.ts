import { registerIcon, registerLegendAction } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { appAssetUrl } from './appPaths';
import type { PineEditorLifecycle } from './pineEditorLifecycle';
import type { PineScriptManager } from './pineScriptManager';
import type { PineModel } from './pineEditorNext';
import type { IndicatorHandle } from '@luxalgo/vela';

interface PineScriptControlsOptions {
  workspace: VelaWorkspace;
  scripts: Record<string, string>;
  getCurrentScriptName(): string;
  setCurrentScriptName(name: string): void;
  editorModels: Map<string, PineModel>;
  scriptHandles: Map<string, Map<string, IndicatorHandle>>;
  groupByCellId: Record<string, string>;
  scriptSelect: HTMLSelectElement;
  editorLifecycle: PineEditorLifecycle;
  scriptManager: PineScriptManager;
  standalone: boolean;
  pineEditorEnabled: boolean;
  isPineTsEnabled(): boolean;
  saveScripts(scripts: Record<string, string>): void;
  validateSource(code: string): Promise<Error | null>;
}

export function initializePineScriptControls(options: PineScriptControlsOptions): {
  openScriptInEditor(name: string, source?: string): Promise<void>;
} {
  const {
    workspace,
    scripts,
    getCurrentScriptName,
    setCurrentScriptName,
    editorModels,
    scriptHandles,
    groupByCellId,
    scriptSelect,
    editorLifecycle,
    scriptManager,
    standalone,
    pineEditorEnabled,
    isPineTsEnabled,
    saveScripts,
    validateSource,
  } = options;

  const setEditorStatus = editorLifecycle.setStatus;
  const getEditorValue = editorLifecycle.getValue;
  const getScriptModel = editorLifecycle.getScriptModel;
  const initializeCodeEditor = editorLifecycle.initialize;
  const loadScriptIntoEditor = editorLifecycle.loadScript;
  const refreshDropdown = editorLifecycle.refreshDropdown;
  const modal = document.getElementById('new-script-modal')!;
  const modalInput = document.getElementById('modal-script-name') as HTMLInputElement;
  const modalConfirmButton = document.getElementById('modal-confirm-btn') as HTMLButtonElement;
  const openStandaloneEditorButton = document.getElementById('btn-open-standalone-editor') as HTMLButtonElement | null;

  scriptSelect.addEventListener('change', () => {
    editorLifecycle.cancelPendingSave();
    setCurrentScriptName(scriptSelect.value);
    loadScriptIntoEditor(scriptSelect.value);
  });

  async function openTauriStandaloneEditor(name: string, source: string): Promise<boolean> {
    scripts[name] = source;
    saveScripts(scripts);
    if (window.velaPineEditorWindow) {
      return window.velaPineEditorWindow.openScript(name, source);
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('window', 'pine-editor');
      url.searchParams.set('script', name);
      const popup = window.open(url.toString(), 'omega-pine-editor-window', 'popup=yes,width=1280,height=820');
      return popup !== null;
    } catch (error) {
      console.error('Could not open the separate Pine Editor:', error);
      return false;
    }
  }

  if (openStandaloneEditorButton) {
    if (standalone) {
      openStandaloneEditorButton.hidden = true;
    } else {
      openStandaloneEditorButton.addEventListener('click', async () => {
        const currentScriptName = getCurrentScriptName();
        if (!window.velaPineEditorWindow) {
          const opened = await openTauriStandaloneEditor(currentScriptName, getEditorValue());
          const message = opened
            ? `Opened "${currentScriptName}" in a separate editor window.`
            : 'The separate Pine Editor window was blocked by the browser.';
          setEditorStatus(message, opened ? 'success' : 'error');
          window.addConsoleActivity?.(message, opened ? 'success' : 'error');
          return;
        }

        openStandaloneEditorButton.disabled = true;
        try {
          const opened = await window.velaPineEditorWindow.openScript(currentScriptName, getEditorValue());
          if (opened) window.toggleEditor(false);
        } finally {
          openStandaloneEditorButton.disabled = false;
        }
      });
    }
  }

  if (!standalone) {
    window.velaPineEditorWindow?.onOpenDocked(() => {
      window.toggleEditor(true);
    });
    window.velaPineEditorWindow?.onScriptUpdated(async ({ name, source, action }) => {
      if (!name || typeof source !== 'string') return;
      scripts[name] = source;
      saveScripts(scripts);
      if (!Object.keys(scripts).includes(getCurrentScriptName())) setCurrentScriptName(name);
      refreshDropdown();
      try {
        const error = action === 'update'
          ? await scriptManager.updateScriptOnChart(name, source)
          : await scriptManager.addScriptToChart(name, source);
        if (error) {
          setEditorStatus(error.message, 'error');
          window.velaPineEditorWindow?.publishScriptResult({ name, action, ok: false, message: error.message });
          return;
        }
        const message = `${action === 'update' ? 'Updated' : 'Added'} "${name}" from the separate Pine Editor.`;
        setEditorStatus(message, 'success');
        window.velaPineEditorWindow?.publishScriptResult({ name, action, ok: true, message });
      } catch (error) {
        const message = `Could not update the chart: ${error instanceof Error ? error.message : String(error)}`;
        setEditorStatus(message, 'error');
        window.velaPineEditorWindow?.publishScriptResult({ name, action, ok: false, message });
      }
    });
  }

  if (standalone) {
    const requestedScript = new URLSearchParams(window.location.search).get('script');
    if (requestedScript && scripts[requestedScript]) setCurrentScriptName(requestedScript);
    window.velaPineEditorWindow?.onOpenScript(({ name, source }) => {
      if (!name || typeof source !== 'string') return;
      scripts[name] = source;
      saveScripts(scripts);
      setCurrentScriptName(name);
      refreshDropdown();
      void initializeCodeEditor().then(() => {
        const model = getScriptModel(name);
        if (model && model.getValue() !== source) model.setValue(source);
        loadScriptIntoEditor(name);
        editorLifecycle.getEditor()?.focus();
        setEditorStatus(`Opened "${name}" from chart.`, 'success');
      });
    });
    window.velaPineEditorWindow?.onScriptResult(({ name, ok, message }) => {
      if (name !== getCurrentScriptName()) return;
      setEditorStatus(message, ok ? 'success' : 'error');
      if (!ok) window.addConsoleOutput?.(message, 'error', `pine:${name}`);
    });
  }

  async function transpileSavedScript(name: string, code: string): Promise<Error | null> {
    const error = await validateSource(code);
    if (!error) {
      const model = editorModels.get(name);
      if (model) editorLifecycle.getCompileDiagnostics()?.(model, null);
      window.clearConsoleDiagnostics?.(`pine:${name}`);
      return null;
    }
    const model = editorModels.get(name);
    if (model) editorLifecycle.getCompileDiagnostics()?.(model, error);
    window.clearConsoleDiagnostics?.(`pine:${name}`);
    scriptManager.displayDiagnosticsInConsole(error, code, name);
    return error;
  }

  document.getElementById('btn-save')!.addEventListener('click', () => {
    void (async () => {
      const currentScriptName = getCurrentScriptName();
      const code = getEditorValue();
      scripts[currentScriptName] = code;
      saveScripts(scripts);
      setEditorStatus(`Saved "${currentScriptName}". Transpiling…`);
      const error = await transpileSavedScript(currentScriptName, code);
      if (error) {
        setEditorStatus(error.message, 'error');
        return;
      }
      setEditorStatus(`Saved and transpiled "${currentScriptName}".`, 'success');
    })();
  });

  async function addOrUpdateCurrentScript(action: 'add' | 'update'): Promise<void> {
    const currentScriptName = getCurrentScriptName();
    const code = action === 'add' ? (scripts[currentScriptName] ?? '') : getEditorValue();

    if (action === 'add' && code !== getEditorValue()) {
      setEditorStatus(`Adding the last saved version of "${currentScriptName}". Save first to use current changes.`);
    } else if (action === 'update') {
      scripts[currentScriptName] = code;
      saveScripts(scripts);
    }

    if (standalone) {
      if (!window.velaPineEditorWindow) {
        setEditorStatus('The main Omega window is not available.', 'error');
        return;
      }
      window.velaPineEditorWindow.publishScriptUpdate({ name: currentScriptName, source: code, action });
      setEditorStatus(`${action === 'add' ? 'Adding' : 'Updating'} "${currentScriptName}" on the main chart…`);
      return;
    }

    setEditorStatus('Compiling Pine script');
    try {
      const error = action === 'add'
        ? await scriptManager.addScriptToChart(currentScriptName, code)
        : await scriptManager.updateScriptOnChart(currentScriptName, code);
      if (error) {
        setEditorStatus(error.message, 'error');
        return;
      }
      setEditorStatus(`${action === 'add' ? 'Added' : 'Updated'} "${currentScriptName}" on chart.`, 'success');
    } catch (error) {
      setEditorStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  document.getElementById('btn-add-to-chart')!.addEventListener('click', () => { void addOrUpdateCurrentScript('add'); });
  document.getElementById('btn-update-chart')!.addEventListener('click', () => { void addOrUpdateCurrentScript('update'); });
  document.getElementById('btn-export-script')!.addEventListener('click', async () => {
    const source = getEditorValue();
    const name = getCurrentScriptName() || 'pine-script';
    try {
      if (window.velaPineExport) {
        const result = await window.velaPineExport.save(name, source);
        if (!result.canceled) setEditorStatus(`Exported "${name}"${result.path ? ` to ${result.path}` : '.'}`, 'success');
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }));
      link.download = `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'pine-script'}.pine`;
      link.click();
      URL.revokeObjectURL(link.href);
      setEditorStatus(`Exported "${name}".`, 'success');
    } catch (error) {
      setEditorStatus(`Could not export script: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });

  document.getElementById('btn-upgrade-v6')!.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      if (!isPineTsEnabled()) {
        throw new Error('PineTS is disabled or unavailable. The chart is still running without Pine script compilation.');
      }
      await initializeCodeEditor();
      const editor = editorLifecycle.getEditor();
      if (!editor) throw new Error('The Pine editor is not ready.');
      const source = editor.getValue();
      const [converterModule, pineTsRuntime] = await Promise.all([
        import('./pineVersionConverter.mjs'),
        import('pinets'),
      ]);
      const conversion = converterModule.convertPineScriptToV6(source);
      editorLifecycle.cancelPendingSave();
      editor.updateOptions({ readOnly: true });
      setEditorStatus(`Checking Pine v${conversion.version} → v6 conversion…`);

      const validationBars = Array.from({ length: 120 }, (_, index) => {
        const close = 100 + Math.sin(index / 4) * 5 + index * 0.03;
        const open = close + Math.sin(index) * 0.3;
        return {
          open,
          high: Math.max(open, close) + 1,
          low: Math.min(open, close) - 1,
          close,
          volume: 100 + index % 17,
          openTime: 1_700_000_000_000 + index * 60_000,
        };
      });
      await new pineTsRuntime.PineTS(validationBars).run(conversion.source);

      const currentScriptName = getCurrentScriptName();
      const chartError = await scriptManager.applyScriptToChart(currentScriptName, conversion.source);
      if (chartError) throw chartError;

      editorLifecycle.setValueWithoutValidation(conversion.source);
      scripts[currentScriptName] = conversion.source;
      saveScripts(scripts);
      setEditorStatus(`Upgraded Pine v${conversion.version} to v6, saved, and compiled "${currentScriptName}".`, 'success');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setEditorStatus(`Unable to upgrade script: ${reason}`, 'error');
    } finally {
      editorLifecycle.getEditor()?.updateOptions({ readOnly: false });
      button.disabled = false;
    }
  });

  document.getElementById('btn-delete')!.addEventListener('click', () => {
    if (Object.keys(scripts).length <= 1) {
      alert('Keep at least one script.');
      return;
    }
    const currentScriptName = getCurrentScriptName();
    if (!confirm(`Delete "${currentScriptName}"?`)) return;
    scriptHandles.get(currentScriptName)?.forEach(handle => handle.remove());
    for (const cell of workspace.cells()) {
      if (cell.id !== workspace.active.id && groupByCellId[cell.id] === groupByCellId[workspace.active.id]) {
        cell.chart.indicators().find(indicator => indicator.id === scriptManager.scriptIndicatorId(currentScriptName))?.remove();
      }
    }
    scriptHandles.delete(currentScriptName);
    editorModels.get(currentScriptName)?.dispose();
    editorModels.delete(currentScriptName);
    delete scripts[currentScriptName];
    saveScripts(scripts);
    const nextScriptName = Object.keys(scripts)[0];
    setCurrentScriptName(nextScriptName);
    refreshDropdown();
    loadScriptIntoEditor(nextScriptName);
    setEditorStatus(`Deleted "${currentScriptName}".`, 'success');
  });

  document.getElementById('btn-new')!.addEventListener('click', () => {
    modalInput.value = '';
    modal.style.display = 'flex';
    setTimeout(() => modalInput.focus(), 50);
  });
  document.getElementById('modal-cancel-btn')!.addEventListener('click', () => {
    modal.style.display = 'none';
  });
  modalConfirmButton.addEventListener('click', () => {
    const name = modalInput.value.trim();
    if (!name) return;
    if (Object.hasOwn(scripts, name)) {
      setEditorStatus(`A script named "${name}" already exists.`, 'error');
      return;
    }
    scripts[name] = `//@version=6\nindicator(${JSON.stringify(name)}, overlay = true)\n\nplot(ta.ema(close, 20), "EMA 20", color = color.yellow)\n`;
    saveScripts(scripts);
    setCurrentScriptName(name);
    refreshDropdown();
    loadScriptIntoEditor(name);
    modal.style.display = 'none';
    setEditorStatus(`Created "${name}".`, 'success');
  });

  async function openScriptInEditor(name: string, source?: string): Promise<void> {
    if (!pineEditorEnabled) {
      throw new Error('The Pine editor module is disabled or unavailable.');
    }
    const drawer = document.getElementById('editor-drawer');
    if (drawer && drawer.style.display !== 'flex') window.toggleEditor(true);

    if (source) {
      scripts[name] = source;
      saveScripts(scripts);
      const existingModel = editorModels.get(name);
      if (existingModel && !existingModel.isDisposed()) existingModel.setValue(source);
    }

    setCurrentScriptName(name);
    refreshDropdown();
    scriptSelect.value = name;
    await initializeCodeEditor();
    loadScriptIntoEditor(name);
    editorLifecycle.getEditor()?.layout();
    editorLifecycle.getEditor()?.focus();
    setEditorStatus(`Editing "${name}"`, 'success');
  }

  if (pineEditorEnabled) {
    registerIcon(
      'source-code',
      '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M5.5 3C4.5 3 4 3.5 4 4.5v2c0 .8-.5 1.5-1.5 1.5.8 0 1.5.7 1.5 1.5v2c0 1 .5 1.5 1.5 1.5M10.5 3c1 0 1.5.5 1.5 1.5v2c0 .8.5 1.5 1.5 1.5-.8 0-1.5.7-1.5 1.5v2c0 1-.5 1.5-1.5 1.5"/>' +
      '</svg>',
    );

    registerLegendAction({
      id: 'open-source-code',
      icon: 'source-code',
      tooltip: 'Source code',
      order: 5,
      when: () => true,
      run: async (_ctx, indicator) => {
        let source = indicator.source;
        const name = indicator.title || 'Indicator';
        if (!source && scripts[name]) source = scripts[name];

        if (!source) {
          try {
            const catalogResponse = await fetch(appAssetUrl('/indicators/catalog.json'));
            if (catalogResponse.ok) {
              const catalog: Array<{ name: string; url: string }> = await catalogResponse.json();
              const cleanName = name.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
              const found = catalog.find(entry => {
                const catalogName = entry.name.toLowerCase();
                return catalogName === cleanName || catalogName.includes(cleanName) || cleanName.includes(catalogName);
              });
              if (found) {
                const sourceResponse = await fetch(appAssetUrl(found.url));
                if (sourceResponse.ok) source = await sourceResponse.text();
              }
            }
          } catch (error) {
            console.warn('Could not fetch source from catalog:', error);
          }
        }

        if (window.velaPineEditorWindow) {
          const sourceToOpen = source ?? scripts[name] ?? '';
          scripts[name] = sourceToOpen;
          saveScripts(scripts);
          const opened = await window.velaPineEditorWindow.openScript(name, sourceToOpen);
          if (opened) return;
        }
        await openScriptInEditor(name, source);
      },
    });
  }

  return { openScriptInEditor };
}
