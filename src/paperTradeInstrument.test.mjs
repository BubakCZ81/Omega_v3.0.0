import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPaperTradeSymbol,
  formatPaperTradeLots,
  formatPaperTradePrice,
  getPaperTradeContractSize,
  getPaperTradeMinTick,
  getPaperTradeQuoteCurrency,
} from './paperTradeInstrument.ts';

test('normalizes paper-trade symbols and formats prices by tick precision', () => {
  assert.equal(cleanPaperTradeSymbol('  binance:btcusdt '), 'BINANCE:BTCUSDT');
  assert.equal(formatPaperTradePrice(12.3456, 0.0001), '12.3456');
  assert.equal(formatPaperTradePrice(12.3, 0.01), '12.30');
  assert.equal(formatPaperTradePrice(12.3, 1e-7), '12.3000000');
  assert.equal(formatPaperTradeLots(0.1), '0.10');
});

test('uses provider metadata for contract size, tick size, and quote currency', () => {
  const info = { contract_size: 50, minTick: 0.25, quote_currency: ' usd ' };
  assert.equal(getPaperTradeContractSize('ES', info), 50);
  assert.equal(getPaperTradeMinTick('ES', info), 0.25);
  assert.equal(getPaperTradeQuoteCurrency('ES', info), 'USD');
});

test('uses instrument defaults when metadata is unavailable', () => {
  assert.equal(getPaperTradeContractSize('BTCUSDT', undefined), 1);
  assert.equal(getPaperTradeMinTick('EURUSD', undefined), 0.0001);
  assert.equal(getPaperTradeQuoteCurrency('BINANCE:BTCUSDT', undefined), 'USDT');
  assert.equal(getPaperTradeQuoteCurrency('ES', undefined), 'USD');
});
