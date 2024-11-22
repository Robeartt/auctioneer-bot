/**
 * Assert that a and b are approximately equal, relative to the smaller of the two,
 * within epsilon as a percentage.
 * @param a
 * @param b
 * @param epsilon - The max allowed difference between a and b as a percentage of the smaller of the two
 */
export function expectRelApproxEqual(a: number, b: number, epsilon = 0.001) {
  expect(Math.abs(a - b) / Math.min(a, b)).toBeLessThanOrEqual(epsilon);
}
