/** ATRAC3plus fitted allocation stage. */

import { fit } from './fit.js'
import { solve } from './solve.js'

/**
 * Compose construction-selected solving and bounded exact-frame fitting.
 *
 * @param {object} context Pipeline ownership context.
 * @returns {Function} Allocation stage.
 */
export function allocate(context) {
  return fit(context, solve(context))
}
