/**
 * Select a preferred scale value using powers of ten and factors of 1, 2, 5, or 10.
 * @param {number} value - The value to scale.
 * @param {boolean} round - Whether to select the nearest preferred factor.
 * @return {number} The preferred scale value, or `1` for invalid or nonpositive input.
 */

function niceNumber(value, round) {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exp = Math.floor(Math.log10(value))
  const f = value / 10 ** exp
  let nf
  if (round) {
    if (f < 1.5) nf = 1
    else if (f < 3) nf = 2
    else if (f < 7) nf = 5
    else nf = 10
  } else if (f <= 1) nf = 1
  else if (f <= 2) nf = 2
  else if (f <= 5) nf = 5
  else nf = 10
  return nf * 10 ** exp
}

/**
 * Computes rounded chart-axis bounds and evenly spaced tick values.
 * @param {number} dataMax - The maximum data value represented on the axis.
 * @param {number} [tickCount=5] - The number of tick values to generate.
 * @returns {{ yMax: number, ticks: number[] }} The axis maximum and generated tick values.
 */
export function computeChartYScale(dataMax, tickCount = 5) {
  const intervals = Math.max(2, tickCount - 1)
  if (!Number.isFinite(dataMax) || dataMax <= 0) {
    return {
      yMax: intervals,
      ticks: Array.from({ length: tickCount }, (_, i) => i),
    }
  }

  const paddedMax = dataMax * 1.1
  const niceMax = niceNumber(paddedMax, false)
  const step = niceNumber(niceMax / intervals, true)
  const yMax = step * intervals
  const ticks = Array.from({ length: tickCount }, (_, i) => i * step)
  return { yMax, ticks }
}

/**
 * Formats a value as a compact Philippine-peso label for chart axes.
 * @param {*} value - The value to format.
 * @return {string} A peso label using whole pesos, `k` for thousands, or `M` for millions.
 */
export function formatChartAxisPeso(value) {
  const v = Number(value) || 0
  if (v >= 1_000_000) {
    const m = v / 1_000_000
    return `₱${m >= 10 ? Math.round(m) : m.toFixed(1)}M`
  }
  if (v >= 10_000) return `₱${Math.round(v / 1000)}k`
  if (v >= 1000) {
    const k = v / 1000
    return Number.isInteger(k) ? `₱${k}k` : `₱${k.toFixed(1)}k`
  }
  return `₱${Math.round(v)}`
}

/**
 * Maps a chart total to its vertical SVG coordinate.
 * @param {number} total - The data total to position.
 * @param {number} yMax - The maximum chart scale.
 * @param {number} top - The top coordinate of the plot area.
 * @param {number} plotHeight - The height of the plot area.
 * @return {number} The calculated vertical coordinate.
 */
export function chartPointY(total, yMax, top, plotHeight) {
  const safeMax = Math.max(Number(yMax) || 1, 1)
  const v = Math.max(0, Number(total) || 0)
  return top + plotHeight - (v / safeMax) * plotHeight
}
