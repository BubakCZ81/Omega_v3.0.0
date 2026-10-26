import { Severity, validatePineScript } from 'pinescript-v6-validator';

export interface PineStaticDiagnostic {
  message: string;
  line: number;
  column: number;
  length: number;
  severity: 'error' | 'warning' | 'info';
  source: string;
}

const diagnosticSource = 'Pine Script v6 Validator (unofficial)';

export function validatePineStaticSource(source: string): PineStaticDiagnostic[] {
  if (!source.trim()) return [];

  const version = source.match(/^\s*\/\/\s*@version\s*=\s*(\d+)\s*$/m)?.[1];
  if (version !== '6') {
    return [{
      message: version
        ? `Static validation supports Pine v6 only; Pine v${version} checks were skipped.`
        : 'Static validation supports Pine v6 only; add //@version=6 to enable it.',
      line: 1,
      column: 1,
      length: 1,
      severity: 'info',
      source: diagnosticSource,
    }];
  }

  return validatePineScript(source).map(diagnostic => ({
    message: diagnostic.message,
    line: Math.max(1, diagnostic.line),
    column: Math.max(1, diagnostic.column + 1),
    length: Math.max(1, diagnostic.length),
    severity: diagnostic.severity === Severity.Error
      ? 'error'
      : diagnostic.severity === Severity.Warning
        ? 'warning'
        : 'info',
    source: diagnosticSource,
  }));
}
