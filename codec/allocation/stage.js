/** ATRAC3plus fitted allocation stage. */

import { fit } from './fit.js'
import { solve } from './solve.js'

/**
 * Compose construction-selected solving and bounded exact-frame fitting.
 *
 * @param {EncoderContext} context Pipeline ownership context.
 * @returns {function(EncoderFrame): EncoderFrame} Allocation stage.
 */
export function allocate(context) {
  return fit(context, solve(context))
}
