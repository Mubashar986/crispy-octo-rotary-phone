// Fixed-timestep accumulator: simulation rate is decoupled from render rate.
export class FixedClock {
  constructor(step = 1 / 30, maxStepsPerFrame = 5) {
    this.step = step;
    this.maxSteps = maxStepsPerFrame;
    this.acc = 0;
  }
  advance(realDt, stepFn) {
    this.acc += Math.min(realDt, 0.25);
    let steps = 0;
    while (this.acc >= this.step && steps < this.maxSteps) {
      stepFn(this.step);
      this.acc -= this.step;
      steps++;
    }
    if (steps === this.maxSteps) this.acc = 0;
    return this.acc / this.step; // interpolation alpha
  }
  reset() { this.acc = 0; }
}
