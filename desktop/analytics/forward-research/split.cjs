'use strict';

// Chronological splits ONLY — rows are assumed pre-sorted ascending by eventTime by the
// dataset builder. No shuffling. Index boundaries respect time order, so the TEST block is
// strictly later than VALIDATION, which is strictly later than TRAIN.

function chronoSplit(rows, fractions = [0.6, 0.2, 0.2]) {
  const n = rows.length;
  const nTrain = Math.floor(n * fractions[0]);
  const nVal = Math.floor(n * fractions[1]);
  return {
    train: rows.slice(0, nTrain),
    validation: rows.slice(nTrain, nTrain + nVal),
    test: rows.slice(nTrain + nVal),
    boundaries: { nTrain, nVal, nTest: n - nTrain - nVal },
  };
}

// Expanding-window walk-forward: split the timeline into (folds+1) contiguous blocks; fold k
// trains on blocks 0..k and tests on block k+1. Never trains on future to evaluate the past.
function walkForward(rows, folds = 4) {
  const n = rows.length; const blocks = folds + 1;
  if (n < blocks * 2) return [];
  const size = Math.floor(n / blocks);
  const out = [];
  for (let k = 0; k < folds; k++) {
    const trainEnd = size * (k + 1);
    const testEnd = (k + 2 === blocks) ? n : size * (k + 2);        // last fold absorbs remainder
    out.push({ fold: k + 1, train: rows.slice(0, trainEnd), test: rows.slice(trainEnd, testEnd) });
  }
  return out;
}

module.exports = { chronoSplit, walkForward };
