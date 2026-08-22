/** ATRAC3plus retained-symbol quantization stage. */

import { quantizeSymbols } from './symbols.js'

/**
 * Materialize final symbols for every retained coding unit.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Quantization stage.
 */
export function quantize(context) {
  const { codingUnitCount } = context.bufferPool.encoder.state.topology
  return (frame) => {
    for (let unit = 0; unit < codingUnitCount; unit++) {
      quantizeSymbols(frame.allocationTransactions[unit])
    }
    return frame
  }
}
