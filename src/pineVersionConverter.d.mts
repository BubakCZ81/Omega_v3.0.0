export interface PineV6Conversion {
  source: string;
  version: number;
  changes: number;
}

export function convertPineScriptToV6(source: string): PineV6Conversion;
