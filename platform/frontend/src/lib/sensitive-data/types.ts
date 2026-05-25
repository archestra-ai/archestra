declare const detectorIdBrand: unique symbol;
export type DetectorId = string & { readonly [detectorIdBrand]: true };

export const detectorId = (id: string): DetectorId => id as DetectorId;

export interface Finding {
  detectorId: DetectorId;
  internalLabel: string;
  startIndex: number;
  endIndex: number;
}

export interface DetectorContext {
  existingFindings: Finding[];
}

export interface Detector {
  id: DetectorId;
  scan(text: string, context?: DetectorContext): Finding[];
}
