/**
 * Pure helpers for the favorite drawing-tools menu. Kept free of Vela/DOM
 * imports so the filtering rules can be unit tested.
 */

/** Favorite tool types in starring order, without blanks or duplicates. */
export function favoriteDrawingToolTypes(favorites: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const type of favorites) {
    if (typeof type !== 'string') continue;
    const normalized = type.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
