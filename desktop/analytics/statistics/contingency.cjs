'use strict';

const { chiSquareSf } = require('./special.cjs');
const { STATUS } = require('./guards.cjs');

// Pearson chi-square test of independence over an R×C contingency matrix, with
// explicit expected-count assumption guards and Cramér's V effect size. `observed`
// is an array of rows (each an array of non-negative integer counts). Never returns
// an authoritative p when the chi-square approximation's assumptions are inadequate.
function chiSquareContingency(observed, { rowLabels = null, colLabels = null } = {}) {
  const rows = observed.length;
  const cols = rows ? observed[0].length : 0;
  const rowTotals = observed.map((r) => r.reduce((a, b) => a + b, 0));
  const colTotals = Array.from({ length: cols }, (_, j) => observed.reduce((a, r) => a + r[j], 0));
  const grand = rowTotals.reduce((a, b) => a + b, 0);
  const base = {
    rows, cols, observed, rowLabels, colLabels, rowTotals, colTotals, n: grand,
    chiSquare: null, df: null, pValue: null, cramersV: null,
    totalCells: rows * cols, expectedMin: null, cellsExpectedLt5: null, pctExpectedLt5: null,
  };
  if (rows < 2 || cols < 2 || grand === 0) return { ...base, status: STATUS.INSUFFICIENT_SAMPLE };

  const expected = observed.map((r, i) => r.map((_, j) => (rowTotals[i] * colTotals[j]) / grand));
  let chi2 = 0, expMin = Infinity, lt5 = 0;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const e = expected[i][j];
    if (e < expMin) expMin = e;
    if (e < 5) lt5++;
    if (e > 0) chi2 += (observed[i][j] - e) ** 2 / e;
  }
  const df = (rows - 1) * (cols - 1);
  const pValue = chiSquareSf(chi2, df);
  const cramersV = grand > 0 ? Math.sqrt(chi2 / (grand * Math.min(rows - 1, cols - 1))) : null;
  const pctExpectedLt5 = (lt5 / (rows * cols)) * 100;
  // Cochran's rule: no expected cell < 1, and ≤20% of cells expected < 5.
  const assumptionsOk = expMin >= 1 && pctExpectedLt5 <= 20;
  return {
    ...base, chiSquare: chi2, df, pValue, cramersV,
    expectedMin: expMin, cellsExpectedLt5: lt5, pctExpectedLt5,
    status: assumptionsOk ? STATUS.OK : STATUS.ASSUMPTION_FAILED,
  };
}

module.exports = { chiSquareContingency };
