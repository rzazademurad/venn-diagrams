/**
 * 1:1 port of `logic/TruthValue.java`.
 *
 * Display methods for truth values: "T"/"F" or "1"/"0".
 */
export const TruthValue = {
  TRUE_FALSE: 0,
  ZERO_ONE: 1,

  getTruthValueString(value: boolean, displayMethod: number): string {
    let valueString: string;
    if (displayMethod === TruthValue.TRUE_FALSE) {
      valueString = value ? 'T' : 'F';
    } else {
      valueString = value ? '1' : '0';
    }
    return valueString;
  },
} as const;

/** Convenience alias mirroring the Java `int displayMethod` parameter. */
export type DisplayMethod = number;
