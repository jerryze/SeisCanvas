const amplitudeNumber = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 3,
});

/** Human-readable amplitude: three significant digits, never scientific notation. */
export function formatAmplitude(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return amplitudeNumber.format(value);
}
