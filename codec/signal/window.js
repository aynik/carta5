/** ATRAC3plus transform-window selection. */

import {
  MDCT_WINDOW_BOTH_TRANSIENT,
  MDCT_WINDOW_CURRENT_TRANSIENT,
  MDCT_WINDOW_PREVIOUS_TRANSIENT,
  MDCT_WINDOW_STEADY,
} from '../core/tables.js'

/**
 * Select the overlap window for adjacent transient flags.
 *
 * @param {number|boolean} previousTransient Previous-window flag.
 * @param {number|boolean} currentTransient Current-window flag.
 * @returns {Float32Array} Selected fixed overlap window.
 */
export function selectMdctWindow(previousTransient, currentTransient) {
  if (!previousTransient && !currentTransient) return MDCT_WINDOW_STEADY
  if (!previousTransient) return MDCT_WINDOW_CURRENT_TRANSIENT
  if (!currentTransient) return MDCT_WINDOW_PREVIOUS_TRANSIENT
  return MDCT_WINDOW_BOTH_TRANSIENT
}
