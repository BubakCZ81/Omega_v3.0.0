import { timeframeToMs } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

export interface ReplayControls {
  open(): void;
  startAt(timestamp: number, cellId?: string): Promise<void>;
  sync(): void;
}

export function initializeReplayControls(
  workspace: VelaWorkspace,
  onReplayActiveChanged: (active: boolean) => void,
): ReplayControls | null {
  const replayMenu = document.getElementById('replay-menu') as HTMLDetailsElement | null;
  const replayFrom = document.getElementById('replay-from') as HTMLInputElement | null;
  const replaySpeed = document.getElementById('replay-speed') as HTMLSelectElement | null;
  const replayStatus = document.getElementById('replay-status') as HTMLElement | null;
  const replayStart = document.getElementById('replay-start') as HTMLButtonElement | null;
  const replayStep = document.getElementById('replay-step') as HTMLButtonElement | null;
  const replayPlayPause = document.getElementById('replay-play-pause') as HTMLButtonElement | null;
  const replayStop = document.getElementById('replay-stop') as HTMLButtonElement | null;

  if (!replayMenu || !replayFrom || !replaySpeed || !replayStatus || !replayStart || !replayStep || !replayPlayPause || !replayStop) return null;

  function localDateTimeInputValue(timestamp: number): string {
    const date = new Date(timestamp);
    const localTime = new Date(timestamp - date.getTimezoneOffset() * 60_000);
    return localTime.toISOString().slice(0, 16);
  }

  function syncReplayControls() {
    const state = workspace.replay.state;
    replayMenu!.dataset.active = String(state.active);
    replayStep!.disabled = !state.active || state.remaining === 0;
    replayPlayPause!.disabled = !state.active || state.remaining === 0;
    replayPlayPause!.textContent = state.playing ? 'Pause' : 'Play';
    replayStop!.disabled = !state.active;
    if (state.active && state.cursorTime != null) {
      replayStatus!.textContent = `${state.remaining} bars remaining · ${new Date(state.cursorTime).toLocaleString()}`;
    } else if (!replayStatus!.textContent?.startsWith('Could not')) {
      replayStatus!.textContent = 'Choose a starting time, then start replay.';
    }
  }

  function suggestReplayStart(): void {
    if (!replayMenu!.open || replayFrom!.value) return;
    const bounds = workspace.replay.bounds;
    if (!bounds) {
      replayStatus!.textContent = 'No replayable chart history is loaded yet.';
      return;
    }
    const timeframe = (workspace.active?.chart ?? workspace.chart).market.timeframe ?? '60';
    const suggestedStart = Math.max(bounds.first, bounds.last - timeframeToMs(timeframe) * 50);
    replayFrom!.value = localDateTimeInputValue(suggestedStart);
  }

  async function startAt(from: number, cellId?: string): Promise<void> {
    if (!Number.isFinite(from)) {
      replayStatus!.textContent = 'Choose a valid replay start date and time.';
      return;
    }
    replayFrom!.value = localDateTimeInputValue(from);
    replayStart!.disabled = true;
    replayStatus!.textContent = 'Preparing replay…';
    onReplayActiveChanged(true);
    try {
      await workspace.replay.start(cellId ? { from, cell: cellId } : { from });
      replayStatus!.textContent = 'Replay paused. Step through bars or start playback.';
    } catch (error) {
      replayStatus!.textContent = `Could not start replay: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      onReplayActiveChanged(workspace.replay.state.active);
      replayStart!.disabled = false;
      syncReplayControls();
    }
  }

  replayMenu.addEventListener('toggle', () => {
    suggestReplayStart();
  });

  replayStart.addEventListener('click', () => {
    void startAt(new Date(replayFrom.value).getTime());
  });

  replayStep.addEventListener('click', () => {
    if (!workspace.replay.step()) replayStatus.textContent = 'No more bars to replay.';
    syncReplayControls();
  });

  replayPlayPause.addEventListener('click', () => {
    const state = workspace.replay.state;
    if (state.playing) workspace.replay.pause();
    else workspace.replay.play(Number(replaySpeed.value));
    syncReplayControls();
  });

  replaySpeed.addEventListener('change', () => {
    if (workspace.replay.state.playing) {
      workspace.replay.play(Number(replaySpeed.value));
    }
  });

  replayStop.addEventListener('click', () => {
    onReplayActiveChanged(false);
    workspace.replay.stop();
    syncReplayControls();
  });

  for (const event of ['replay:start', 'replay:step', 'replay:play', 'replay:pause', 'replay:end'] as const) {
    workspace.replay.on(event, () => {
      onReplayActiveChanged(workspace.replay.state.active);
      syncReplayControls();
    });
  }

  syncReplayControls();
  suggestReplayStart();
  return {
    open() {
      replayMenu!.open = true;
      replayMenu!.querySelector<HTMLElement>('summary')?.focus();
    },
    startAt,
    sync: syncReplayControls,
  };
}
