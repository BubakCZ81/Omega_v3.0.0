export function appAssetUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), document.baseURI).href;
}
