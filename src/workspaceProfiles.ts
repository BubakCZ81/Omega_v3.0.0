import type { VelaWorkspace } from '@luxalgo/vela/workspace';

export function ensureWorkspaceScriptLedger(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { charts?: unknown }).charts)) return value;
  const document = value as { charts: unknown[] };
  return {
    ...document,
    charts: document.charts.map(chart => {
      if (!chart || typeof chart !== 'object' || Array.isArray(chart)) return chart;
      const entry = chart as { ext?: unknown };
      const ext = entry.ext && typeof entry.ext === 'object' && !Array.isArray(entry.ext)
        ? entry.ext as Record<string, unknown>
        : {};
      return {
        ...entry,
        ext: {
          ...ext,
          'omega.scriptIndicators': Array.isArray(ext['omega.scriptIndicators']) ? ext['omega.scriptIndicators'] : [],
        },
      };
    }),
  };
}

export function initializeWorkspaceProfiles(
  workspace: VelaWorkspace,
  onApplyState: (state: unknown) => void,
): void {
  const profileNameInput = document.getElementById('workspace-profile-name') as HTMLInputElement | null;
  const saveBtn = document.getElementById('workspace-save-profile') as HTMLButtonElement | null;
  const loadBtn = document.getElementById('workspace-load-profile') as HTMLButtonElement | null;

  async function run(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
    }
  }

  saveBtn?.addEventListener('click', () => { void run(saveBtn, async () => {
    const name = profileNameInput?.value.trim() ?? '';
    const state = JSON.stringify(workspace.getState());
    try {
      if (window.velaWorkspaceFiles) {
        const result = await window.velaWorkspaceFiles.saveProfile(name, state);
        workspace.toast(
          result.canceled ? 'Workspace save canceled.' : `Workspace saved${result.path ? `: ${result.path}` : '.'}`,
          result.canceled ? 'info' : 'success',
        );
        return;
      }
      if (!name) {
        workspace.toast('Enter a workspace name first.', 'error');
        return;
      }
      localStorage.setItem(`vela-profile:${name}`, state);
      workspace.toast(`Workspace "${name}" saved.`, 'success');
    } catch (error) {
      workspace.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }); });

  loadBtn?.addEventListener('click', () => { void run(loadBtn, async () => {
    try {
      if (window.velaWorkspaceFiles) {
        const result = await window.velaWorkspaceFiles.loadProfile();
        if (result.canceled) workspace.toast('Workspace load canceled.', 'info');
        else if (result.state) {
          onApplyState(ensureWorkspaceScriptLedger(JSON.parse(result.state)));
          workspace.toast(`Workspace loaded${result.path ? `: ${result.path}` : '.'}`, 'success');
        }
        return;
      }
      const name = profileNameInput?.value.trim() ?? '';
      const state = name ? localStorage.getItem(`vela-profile:${name}`) : null;
      if (!state) {
        workspace.toast('Workspace profile not found.', 'error');
        return;
      }
      onApplyState(ensureWorkspaceScriptLedger(JSON.parse(state)));
    } catch (error) {
      workspace.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }); });
}
