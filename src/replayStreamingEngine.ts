import type { ScriptingEngine } from '@luxalgo/vela/plugin';

export function createReplayAwareEngine(
  engine: ScriptingEngine,
  isReplayActive: () => boolean,
): ScriptingEngine {
  return {
    language: engine.language,
    capabilities: engine.capabilities,
    prepare: (source, instanceId) => engine.prepare(source, instanceId),
    execute: (request, handlers) => {
      if (!isReplayActive() || !engine.capabilities.streaming || request.mode === 'live') {
        return engine.execute(request, handlers);
      }
      return engine.execute({ ...request, mode: 'live' }, handlers);
    },
  };
}
