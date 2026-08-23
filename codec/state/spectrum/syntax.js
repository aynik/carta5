/** Reusable scalar state for ATRAC3plus spectrum pricing and emission. */

/**
 * Reusable fields for one four-symbol spectral zero-run chunk.
 */
export class SpectrumSymbolScratch {
  /**
   * Allocate fixed symbol, sign-bits, and sign-count rows.
   */
  constructor() {
    this.symbols = new Uint16Array(4)
    this.extraBits = new Uint32Array(4)
    this.extraCounts = new Uint8Array(4)
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
