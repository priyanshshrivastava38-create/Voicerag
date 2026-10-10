/** pgvector text literal for a float vector (bound as a parameter, cast with ::vector). */
export function vectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;
}
