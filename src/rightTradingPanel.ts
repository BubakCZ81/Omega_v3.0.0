import type { VelaWorkspace } from '@luxalgo/vela/workspace';

export async function initializeRightTradingPanel(workspace: VelaWorkspace) {
  const paperTrading = await import('./chartPaperTrading');
  paperTrading.initializeChartPaperTrading(workspace);
  return paperTrading;
}
