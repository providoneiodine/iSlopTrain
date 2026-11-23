/*
 * Adaptive difficulty: transformed up-down staircase (Levitt, 1971).
 *
 * nDown consecutive correct -> harder, 1 error -> easier. 2-down/1-up
 * converges on ~70.7 % correct, keeping the athlete at a "challenge point"
 * (Guadagnoli & Lee, 2004) - hard enough to learn from, easy enough to
 * stay motivated. Steps are multiplicative (log-spaced), which suits
 * durations, and shrink over the first reversals for a finer estimate.
 */
(function () {
  'use strict';
  const U = IST.util;

  class Staircase {
    constructor(o) {
      this.min = o.min;
      this.max = o.max;
      this.value = U.clamp(o.start, o.min, o.max);
      this.factor = o.factor || 1.3;
      this.minFactor = o.minFactor || 1.07;
      this.nDown = o.nDown || 2;
      this.lowerIsHarder = o.lowerIsHarder !== false;
      this.streak = 0;
      this.lastDir = 0;
      this.reversals = [];
      this.history = [];
    }

    update(correct) {
      this.history.push({ value: this.value, correct: !!correct });
      let dir = 0; // -1 = harder, +1 = easier
      if (correct) {
        if (++this.streak >= this.nDown) {
          this.streak = 0;
          dir = -1;
        }
      } else {
        this.streak = 0;
        dir = 1;
      }
      if (!dir) return this.value;
      if (this.lastDir && dir !== this.lastDir) {
        this.reversals.push(this.value);
        if (this.reversals.length <= 4) this.factor = Math.max(this.minFactor, Math.sqrt(this.factor));
      }
      this.lastDir = dir;
      const shrink = (dir === -1) === this.lowerIsHarder;
      this.value = U.clamp(shrink ? this.value / this.factor : this.value * this.factor, this.min, this.max);
      return this.value;
    }

    /** Threshold estimate: geometric mean of recent reversals (first two discarded). */
    threshold(n) {
      n = n || 6;
      const r = this.reversals.length > 3 ? this.reversals.slice(2) : [];
      if (r.length >= 2) return U.geomean(r.slice(-n));
      const h = this.history.slice(-8).map((x) => x.value);
      return h.length ? U.geomean(h) : NaN;
    }
  }

  IST.Staircase = Staircase;
})();
