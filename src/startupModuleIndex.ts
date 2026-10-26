export type ModuleHealthState = 'ready' | 'missing' | 'recovered' | 'failed';

export interface StartupModuleDefinition {
  id: string;
  label: string;
  isReady(): boolean | Promise<boolean>;
  recover?(): void | Promise<void>;
}

type RecordDiagnostic = (entry: {
  source: string;
  type: string;
  name: string;
  status: 'ok' | 'error' | 'start';
  message: string;
}) => void;

/**
 * Verifies the modules that have a visible effect on the trading workspace.
 * Recovery is deliberately one-shot: a broken optional module must not create
 * an endless retry loop or keep consuming CPU after the platform has opened.
 */
export class StartupModuleIndex {
  private readonly modules: StartupModuleDefinition[] = [];

  constructor(private readonly record: RecordDiagnostic | undefined) {}

  register(definition: StartupModuleDefinition): void {
    if (this.modules.some(module => module.id === definition.id)) return;
    this.modules.push(definition);
  }

  async verifyAndRecover(): Promise<Record<string, ModuleHealthState>> {
    const result: Record<string, ModuleHealthState> = {};
    for (const module of this.modules) {
      let ready = await module.isReady();
      if (ready) {
        result[module.id] = 'ready';
        this.log(module, 'ok', 'ready');
        continue;
      }
      this.log(module, 'start', 'missing; attempting one recovery.');
      if (!module.recover) {
        result[module.id] = 'missing';
        this.log(module, 'error', 'missing and has no safe recovery action.');
        continue;
      }
      try {
        await module.recover();
        ready = await module.isReady();
        result[module.id] = ready ? 'recovered' : 'failed';
        this.log(module, ready ? 'ok' : 'error', ready ? 'recovered.' : 'recovery did not make the module ready.');
      } catch (error) {
        result[module.id] = 'failed';
        this.log(module, 'error', error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }

  private log(module: StartupModuleDefinition, status: 'ok' | 'error' | 'start', message: string): void {
    this.record?.({
      source: 'startup-index', type: 'module', name: module.id, status,
      message: `${module.label}: ${message}`,
    });
  }
}
