import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { buildNeuralTrainingSamples, loadNeuralSignalSeries, validateNeuralSignalSource, type NeuralSignalSeriesHandle, type NeuralTrainingSample } from './pineSignalAdapter';

type NeuralWorkerMessage =
  | { type: 'ready'; memory: string } | { type: 'progress'; epoch: number; epochs: number; loss: number; validationAccuracy: number }
  | { type: 'trained'; metrics: { trainSamples: number; validationSamples: number }; model: unknown }
  | { type: 'cancelled' } | { type: 'disposed'; released: boolean } | { type: 'error'; message: string };
type ModelProfile = { version: 1; name: string; trainedAt: string; symbol: string; timeframe: string; samples: number; featureKeys: string[]; horizonBars: number; metrics: unknown; model: unknown };
let activeLab: NeuralNetworkLab | null = null;

function diagnostic(name: string, status: 'start' | 'ok' | 'error' | 'warning', message?: string): void {
  window.velaDiagnostics?.record({ source: 'neural-network', type: 'lifecycle', name, status, message });
}

class NeuralNetworkLab {
  constructor(private readonly workspace: VelaWorkspace) {}
  private root: HTMLElement | null = null;
  private worker: Worker | null = null;
  private listeners: AbortController | null = null;
  private status: HTMLElement | null = null;
  private profile: ModelProfile | null = null;
  private training = false;

  open(): void {
    if (this.root) { this.root.hidden = false; this.root.querySelector<HTMLButtonElement>('[data-nn-train]')?.focus(); diagnostic('lab.reopened', 'ok'); return; }
    diagnostic('lab.opened', 'start'); this.listeners = new AbortController();
    const root = document.createElement('section'); root.id = 'omega-neural-network-lab'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Neural Network Lab');
    root.innerHTML = `
      <div class="omega-nn-card"><header><strong>Neural Network Lab</strong><button class="btn" type="button" data-nn-close aria-label="Close Neural Network Lab">×</button></header>
      <p class="omega-nn-note">A small local network learns whether Pine signals should be <em>Trade</em> or <em>Skip</em>. It cannot place live orders.</p>
      <div class="omega-nn-grid"><label>Signal source<select data-nn-source aria-label="Pine signal source"></select></label><label>Market<select disabled><option>Selected chart</option></select></label><label>Timeframe<select disabled><option>Selected chart</option></select></label><label>History<input disabled value="Loaded chart candles" aria-label="Training candles"></label></div>
      <p class="omega-nn-status" data-nn-status role="status">Preparing isolated worker…</p><p class="omega-nn-warning" data-nn-warning>Select a valid Pine signal indicator.</p>
      <footer><button class="btn" type="button" data-nn-diagnostics>Open diagnostics</button><button class="btn" type="button" data-nn-save disabled>Save model</button><button class="btn btn-primary" type="button" data-nn-train disabled>Train neural network</button></footer></div>`;
    document.body.append(root); this.root = root; this.status = root.querySelector('[data-nn-status]');
    const sourceSelect = root.querySelector<HTMLSelectElement>('[data-nn-source]')!;
    const sources = this.workspace.chart.indicators().filter(item => typeof item.source === 'string' && typeof (item as unknown as NeuralSignalSeriesHandle).series === 'function');
    sourceSelect.replaceChildren(...sources.map(item => new Option(item.title, item.id))); if (!sources.length) sourceSelect.append(new Option('No compatible Pine signal indicator on this chart', ''));
    const selected = () => sources.find(item => item.id === sourceSelect.value);
    const validate = () => { const result = validateNeuralSignalSource(selected()?.source); const warning = root.querySelector<HTMLElement>('[data-nn-warning]'); if (warning) warning.textContent = result.message; root.querySelector<HTMLButtonElement>('[data-nn-train]')!.disabled = !result.ok || !this.worker; diagnostic('signal.validation', result.ok ? 'ok' : 'warning', result.message); };
    sourceSelect.addEventListener('change', validate, { signal: this.listeners.signal });
    root.querySelector('[data-nn-train]')?.addEventListener('click', () => void this.beginTraining(selected()), { signal: this.listeners.signal });
    root.querySelector('[data-nn-save]')?.addEventListener('click', () => void this.saveModel(), { signal: this.listeners.signal });
    root.querySelector('[data-nn-close]')?.addEventListener('click', () => this.dispose(), { signal: this.listeners.signal });
    root.querySelector('[data-nn-diagnostics]')?.addEventListener('click', () => void window.velaDiagnostics?.openConsole(), { signal: this.listeners.signal });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') this.dispose(); }, { signal: this.listeners.signal });
    this.startWorker(); validate();
  }

  private startWorker(): void {
    try { const worker = new Worker(new URL('./neuralNetworkWorker.ts', import.meta.url), { type: 'module', name: 'omega-neural-network' }); this.worker = worker; worker.addEventListener('message', event => this.onWorkerMessage(event.data as NeuralWorkerMessage), { signal: this.listeners?.signal }); worker.addEventListener('error', event => this.setError(event.message || 'Worker failed to start.'), { signal: this.listeners?.signal }); worker.postMessage({ type: 'start' }); diagnostic('worker.started', 'ok'); }
    catch (error) { this.setError(error instanceof Error ? error.message : 'Worker failed to start.'); }
  }

  private async beginTraining(handle: unknown): Promise<void> {
    if (!this.worker || this.training || !handle) return;
    const source = handle as { source?: string; title?: string; series?: NeuralSignalSeriesHandle['series'] };
    const contract = validateNeuralSignalSource(source.source); if (!contract.ok || typeof source.series !== 'function') return this.setError(contract.message);
    this.training = true; this.profile = null;
    const trainButton = this.root?.querySelector<HTMLButtonElement>('[data-nn-train]');
    const saveButton = this.root?.querySelector<HTMLButtonElement>('[data-nn-save]');
    if (trainButton) trainButton.disabled = true;
    if (saveButton) saveButton.disabled = true;
    try {
      if (this.status) this.status.textContent = 'Reading settled signal history…';
      const series = await loadNeuralSignalSeries({ series: source.series.bind(handle) }, contract.featureKeys);
      const samples = buildNeuralTrainingSamples(series, contract.featureKeys);
      if (samples.length < 100) throw new Error(`Only ${samples.length} settled signals found. Load more candles or use a more active signal.`);
      this.worker.postMessage({ type: 'train', samples: samples satisfies NeuralTrainingSample[], epochs: 45 });
      const market = this.workspace.chart.market; this.profile = { version: 1, name: source.title || 'Pine signal model', trainedAt: new Date().toISOString(), symbol: market?.symbol || 'unknown', timeframe: market?.timeframe || 'unknown', samples: samples.length, featureKeys: contract.featureKeys, horizonBars: 12, metrics: {}, model: null };
      if (this.status) this.status.textContent = `Training on ${samples.length} settled signal examples…`; diagnostic('training.started', 'start', `${samples.length} samples`);
    } catch (error) { this.training = false; this.setError(error instanceof Error ? error.message : 'Could not read signal history.'); }
  }

  private onWorkerMessage(message: NeuralWorkerMessage): void {
    if (message.type === 'ready') { if (this.status) this.status.textContent = `Worker ready · ${message.memory}`; diagnostic('worker.ready', 'ok', message.memory); return; }
    if (message.type === 'progress') { if (this.status) this.status.textContent = `Training ${message.epoch}/${message.epochs} · loss ${message.loss.toFixed(3)} · validation ${(message.validationAccuracy * 100).toFixed(1)}%`; return; }
    if (message.type === 'trained') { this.training = false; if (this.profile) { this.profile.metrics = message.metrics; this.profile.model = message.model; } if (this.status) this.status.textContent = `Training complete · ${message.metrics.trainSamples} train / ${message.metrics.validationSamples} validation signals.`; const saveButton = this.root?.querySelector<HTMLButtonElement>('[data-nn-save]'); const trainButton = this.root?.querySelector<HTMLButtonElement>('[data-nn-train]'); if (saveButton) saveButton.disabled = !this.profile; if (trainButton) trainButton.disabled = false; diagnostic('training.complete', 'ok', `${message.metrics.trainSamples} train samples`); return; }
    if (message.type === 'cancelled') { this.training = false; diagnostic('training.cancelled', 'warning'); return; }
    if (message.type === 'disposed') { diagnostic('worker.disposed', 'ok', 'All worker references released.'); return; }
    this.training = false; this.setError(message.message);
  }

  private async saveModel(): Promise<void> {
    if (!this.profile) return;
    try { const result = await window.velaNeural?.saveModel(this.profile); if (!result) throw new Error('Secure model storage is not available.'); if (this.status) this.status.textContent = `Saved model: ${result.file}`; diagnostic('model.saved', 'ok', result.file); }
    catch (error) { this.setError(error instanceof Error ? error.message : 'Could not save model.'); }
  }
  private setError(message: string): void { if (this.status) this.status.textContent = `Neural network: ${message}`; const trainButton = this.root?.querySelector<HTMLButtonElement>('[data-nn-train]'); if (trainButton) trainButton.disabled = false; diagnostic('worker.error', 'error', message); }
  dispose(): void { diagnostic('lab.cleanup.started', 'start'); const worker = this.worker; this.worker = null; if (worker) { try { if (this.training) worker.postMessage({ type: 'cancel' }); worker.postMessage({ type: 'dispose' }); } catch { /* Worker may already be gone. */ } worker.terminate(); diagnostic('worker.terminated', 'ok'); } this.listeners?.abort(); this.listeners = null; this.status = null; this.profile = null; this.training = false; this.root?.remove(); this.root = null; if (activeLab === this) activeLab = null; diagnostic('lab.cleanup.complete', 'ok', 'Listeners, DOM, model and worker released.'); }
}
export function openNeuralNetworkLab(workspace: VelaWorkspace): void { activeLab ??= new NeuralNetworkLab(workspace); activeLab.open(); }
