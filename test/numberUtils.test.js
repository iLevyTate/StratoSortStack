const {
  parsePositiveInt,
  toPercentNumber,
  toFiniteNonNegativeNumber
} = require('../src/shared/numberUtils');

describe('numberUtils', () => {
  test('parsePositiveInt accepts positive integers and rejects the rest', () => {
    expect(parsePositiveInt('8')).toBe(8);
    expect(parsePositiveInt(3)).toBe(3);
    expect(parsePositiveInt('0')).toBeNull();
    expect(parsePositiveInt(-2)).toBeNull();
    expect(parsePositiveInt('')).toBeNull();
    expect(parsePositiveInt(null)).toBeNull();
  });

  test('toPercentNumber clamps to 0–100', () => {
    expect(toPercentNumber(42)).toBe(42);
    expect(toPercentNumber(-5)).toBe(0);
    expect(toPercentNumber(150)).toBe(100);
    expect(toPercentNumber('not-a-number')).toBe(0);
  });

  test('toFiniteNonNegativeNumber falls back for invalid values', () => {
    expect(toFiniteNonNegativeNumber(12)).toBe(12);
    expect(toFiniteNonNegativeNumber(-1, 7)).toBe(7);
    expect(toFiniteNonNegativeNumber('nope', 3)).toBe(3);
  });
});
