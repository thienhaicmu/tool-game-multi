'use strict';

// Shared ODD thresholds for Aviator Analytics round metrics. Single source of
// truth consumed by the schema (column generation), the RoundAssembler (metric
// derivation) and any future analytics. Column/field keys are threshold*100 so
// they are integer identifiers with no decimal point (1.20x -> 120).

const THRESHOLDS = Object.freeze([1.20, 1.50, 2.00, 3.00, 5.00, 10.00, 20.00, 50.00, 100.00, 500.00, 1000.00]);

function thresholdKey(t) { return Math.round(Number(t) * 100); } // 1.20 -> 120

// e.g. { reached: 'reached_120', time: 'time_to_120_ms' }
function columnsFor(t) {
  const k = thresholdKey(t);
  return { reached: `reached_${k}`, time: `time_to_${k}_ms` };
}

module.exports = { THRESHOLDS, thresholdKey, columnsFor };
