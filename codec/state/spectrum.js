/** Reusable scalar state for ATRAC3plus spectrum pricing and emission. */

/**
 * Reusable fields for one lowered spectral symbol and its sign payload.
 */
export class SpectrumSymbolScratch {
  /**
   * Allocate the fixed symbol, sign-bits, and sign-count fields.
   */
  constructor() {
    this.fields = new Uint32Array(3)
  }
}

/**
 * Fixed scratch shared by channel spectrum emission and exact measurement.
 */
export class SpectrumSyntaxScratch {
  /**
   * Allocate one reusable lowered-symbol owner.
   */
  constructor() {
    this.symbol = new SpectrumSymbolScratch()
  }
}
