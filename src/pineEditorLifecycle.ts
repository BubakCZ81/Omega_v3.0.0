import type { PineEditor, PineModel } from './pineEditorNext';

type PineEditorModule = typeof import('./pineEditorNext');
type PineReferenceModule = typeof import('./pineReferencePanel');

interface PineEditorLifecycleOptions {
  editorHost: HTMLElement;
  editorStatus: HTMLElement;
  editorModels: Map<string, PineModel>;
  scriptSelect: HTMLSelectElement;
  getScripts(): Record<string, string>;
  getCurrentScriptName(): string;
  getTheme(): 'dark' | 'light';
  isEnabled(): boolean;
  standalone: boolean;
  standaloneModules: Promise<[PineEditorModule, PineReferenceModule]> | null;
  saveScripts(scripts: Record<string, string>): void;
  validateSource(code: string): Promise<Error | null>;
  displayDiagnostics(error: Error, code: string, name: string): void;
}

export interface PineEditorLifecycle {
  attach(): void;
  cancelPendingSave(): void;
  getEditor(): PineEditor | null;
  getScriptModel(name: string): PineModel | null;
  getValue(): string;
  initialize(): Promise<void>;
  loadScript(name: string): void;
  refreshDropdown(): void;
  setStatus(message: string, state?: 'error' | 'success' | '', writeActivity?: boolean): void;
  setValueWithoutValidation(value: string): void;
  setTheme(theme: 'dark' | 'light'): void;
  getDiagnostics(): ((model: PineModel, error: Error | null) => void) | null;
  getCompileDiagnostics(): ((model: PineModel, error: Error | null) => void) | null;
}

export function createPineEditorLifecycle(options: PineEditorLifecycleOptions): PineEditorLifecycle {
  const {
    editorHost,
    editorStatus,
    editorModels,
    scriptSelect,
    getScripts,
    getCurrentScriptName,
    getTheme,
    isEnabled,
    standalone,
    standaloneModules,
    saveScripts,
    validateSource,
    displayDiagnostics,
  } = options;

  let pineEditor: PineEditor | null = null;
  let createPineModel: PineEditorModule['createPineModel'] | null = null;
  let setPineEditorTheme: PineEditorModule['setPineEditorTheme'] | null = null;
  let setPineDiagnostics: PineEditorModule['setPineDiagnostics'] | null = null;
  let setPineCompileDiagnostics: PineEditorModule['setPineCompileDiagnostics'] | null = null;
  let editorLoad: Promise<void> | null = null;
  let autosaveTimer: number | undefined;
  let liveValidationTimer: number | undefined;
  let liveValidationRevision = 0;
  let isApplyingPineUpgrade = false;
  let renderPineReference: (filter?: string) => void = () => undefined;
  let attached = false;

  function setStatus(message: string, state: 'error' | 'success' | '' = '', writeActivity = state !== 'error'): void {
    editorStatus.textContent = '';
    editorStatus.title = message;
    if (state) editorStatus.dataset.state = state;
    else delete editorStatus.dataset.state;
    if (writeActivity && message !== 'Unsaved changes') window.addConsoleActivity?.(message, state || 'info');
  }

  function getScriptModel(name: string): PineModel | null {
    if (!createPineModel) return null;
    const existing = editorModels.get(name);
    if (existing && !existing.isDisposed()) return existing;
    const model = createPineModel(`inmemory://pine/${encodeURIComponent(name)}.pine`, getScripts()[name] ?? '');
    editorModels.set(name, model);
    return model;
  }

  async function initialize(): Promise<void> {
    if (!isEnabled()) {
      throw new Error('The Pine editor module is disabled or unavailable.');
    }
    if (pineEditor) {
      const model = getScriptModel(getCurrentScriptName());
      if (model) pineEditor.setModel(model);
      pineEditor.layout();
      pineEditor.focus();
      return;
    }

    if (!editorLoad) {
      editorLoad = (async () => {
        const [editorModule, referenceModule] = standaloneModules
          ? await standaloneModules
          : await Promise.all([import('./pineEditorNext'), import('./pineReferencePanel')]);
        createPineModel = editorModule.createPineModel;
        setPineEditorTheme = editorModule.setPineEditorTheme;
        setPineDiagnostics = editorModule.setPineDiagnostics;
        setPineCompileDiagnostics = editorModule.setPineCompileDiagnostics;
        const referencePanel = referenceModule.createPineReferencePanel(() => pineEditor);
        renderPineReference = filter => referencePanel.render(filter);

        const model = getScriptModel(getCurrentScriptName());
        if (!model) throw new Error('Could not create the Pine editor model.');

        pineEditor = editorModule.createPineEditor(editorHost, model, getTheme());
        pineEditor.onMouseDown(event => {
          if (event.event.browserEvent.detail !== 2 || !event.target.position) return;
          const activeModel = pineEditor?.getModel();
          if (!activeModel) return;
          const referenceName = editorModule.getPineReferenceNameAtPosition(activeModel, event.target.position);
          if (referenceName) referencePanel.open(referenceName);
        });
        pineEditor.onDidChangeModelContent(() => {
          if (isApplyingPineUpgrade) return;
          const editedModel = pineEditor?.getModel();
          const validationName = getCurrentScriptName();
          const diagnosticKey = `pine:${validationName}`;
          window.clearConsoleDiagnostics?.(diagnosticKey);
          if (editedModel) {
            setPineDiagnostics?.(editedModel, null);
            for (const diagnostic of editorModule.getPineSyntaxDiagnostics(editedModel)) {
              window.addConsoleOutput?.(
                `Line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`,
                diagnostic.severity,
                diagnosticKey,
              );
            }
          }
          window.clearTimeout(liveValidationTimer);
          const validationRevision = ++liveValidationRevision;
          const validationCode = editedModel?.getValue() ?? '';
          liveValidationTimer = window.setTimeout(() => {
            void validateSource(validationCode).then(error => {
              if (validationRevision !== liveValidationRevision || getCurrentScriptName() !== validationName) return;
              const currentModel = pineEditor?.getModel();
              if (currentModel) setPineCompileDiagnostics?.(currentModel, error);
              if (error) {
                window.clearConsoleDiagnostics?.(`pine:${validationName}`);
                displayDiagnostics(error, validationCode, validationName);
              }
            });
          }, 100);
          window.clearTimeout(autosaveTimer);
          setStatus('Unsaved changes');
          const modelName = validationName;
          const activeModel = pineEditor?.getModel();

          autosaveTimer = window.setTimeout(() => {
            if (!activeModel || activeModel.isDisposed()) return;

            const nextValue = activeModel.getValue();
            getScripts()[modelName] = nextValue;
            saveScripts(getScripts());
            if (getCurrentScriptName() === modelName) setStatus(`Auto-saved "${modelName}".`, 'success');
          }, 750);
        });

        renderPineReference();
        pineEditor.focus();
      })().catch((error: unknown) => {
        editorLoad = null;
        throw error;
      });
    }

    await editorLoad;
  }

  function attach(): void {
    if (attached) return;
    attached = true;
    window.addEventListener('editor-opened', () => {
      if (!isEnabled()) return;
      void initialize().catch((error: unknown) => {
        setStatus(`Editor failed to load: ${error instanceof Error ? error.message : String(error)}`, 'error');
      });
    });

    if (standalone && isEnabled()) {
      void initialize().catch((error: unknown) => {
        setStatus(`Editor failed to load: ${error instanceof Error ? error.message : String(error)}`, 'error');
      });
    }
  }

  function loadScript(name: string): void {
    const model = getScriptModel(name);
    if (model) {
      pineEditor?.setModel(model);
      if (pineEditor) setStatus(`Editing "${name}"`);
    }
  }

  function cancelPendingSave(): void {
    window.clearTimeout(autosaveTimer);
  }

  function refreshDropdown(): void {
    scriptSelect.replaceChildren();
    for (const name of Object.keys(getScripts())) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      option.selected = name === getCurrentScriptName();
      scriptSelect.appendChild(option);
    }
  }

  return {
    attach,
    cancelPendingSave,
    getEditor: () => pineEditor,
    getScriptModel,
    getValue: () => pineEditor?.getValue() ?? getScripts()[getCurrentScriptName()] ?? '',
    initialize,
    loadScript,
    refreshDropdown,
    setStatus,
    setValueWithoutValidation: value => {
      if (!pineEditor) throw new Error('The Pine editor is not ready.');
      isApplyingPineUpgrade = true;
      try {
        pineEditor.setValue(value);
      } finally {
        isApplyingPineUpgrade = false;
      }
    },
    setTheme: theme => setPineEditorTheme?.(theme),
    getDiagnostics: () => setPineDiagnostics,
    getCompileDiagnostics: () => setPineCompileDiagnostics,
  };
}
