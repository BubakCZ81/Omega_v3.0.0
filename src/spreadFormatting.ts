const ZERO_SPREAD = '0.0';

export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = Number(exponentText ?? 0);
  const decimals = coefficient.includes('.') ? coefficient.length - coefficient.indexOf('.') - 1 : 0;
  return Math.max(0, Math.min(12, decimals - exponent));
}

export function resolveSpreadDigits(
  info: Record<string, unknown> | null | undefined,
  bid: number,
  ask: number,
  inferredPipSize: number | null = null,
): number {
  const metadataDigits = Number(info?.digits);
  if (Number.isInteger(metadataDigits) && metadataDigits >= 0 && metadataDigits <= 12) {
    return metadataDigits;
  }

  const quoteDigits = Math.max(decimalPlaces(bid), decimalPlaces(ask));
  if (quoteDigits > 0) return quoteDigits;
  if (inferredPipSize !== null) return decimalPlaces(inferredPipSize) + 1;

  const pipSize = Number(info?.pipSize ?? info?.pip_size);
  if (Number.isFinite(pipSize) && pipSize > 0) return decimalPlaces(pipSize) + 1;

  const minTick = Number(info?.minTick ?? info?.mintick);
  return decimalPlaces(minTick);
}

export function formatSpreadByPriceDigits(bid: number, ask: number, digits: number): string {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid
    || !Number.isInteger(digits) || digits < 0 || digits > 12) {
    return ZERO_SPREAD;
  }
  const pipScale = 10 ** Math.max(0, digits - 1);
  return ((ask - bid) * pipScale).toFixed(1);
}
