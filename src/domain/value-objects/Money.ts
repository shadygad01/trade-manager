/**
 * Fixed-point money value object.
 *
 * Plain floating point (0.1 + 0.2 !== 0.3) is not acceptable for cost-basis and
 * P/L math that gets summed across hundreds of trades. Money stores amounts as
 * integer micros (value * 1_000_000) so arithmetic never drifts, and only
 * converts back to a float at the presentation boundary.
 */
export class Money {
  private static readonly SCALE = 1_000_000;

  private constructor(private readonly micros: number) {}

  static zero(): Money {
    return new Money(0);
  }

  static from(value: number | string): Money {
    const n = typeof value === "string" ? Number.parseFloat(value) : value;
    if (!Number.isFinite(n)) {
      throw new Error(`Money.from received a non-finite value: ${value}`);
    }
    return new Money(Math.round(n * Money.SCALE));
  }

  add(other: Money): Money {
    return new Money(this.micros + other.micros);
  }

  subtract(other: Money): Money {
    return new Money(this.micros - other.micros);
  }

  multiply(scalar: number): Money {
    return new Money(Math.round(this.micros * scalar));
  }

  divide(scalar: number): Money {
    if (scalar === 0) return Money.zero();
    return new Money(Math.round(this.micros / scalar));
  }

  negate(): Money {
    return new Money(-this.micros);
  }

  isZero(): boolean {
    return this.micros === 0;
  }

  isNegative(): boolean {
    return this.micros < 0;
  }

  isPositive(): boolean {
    return this.micros > 0;
  }

  compareTo(other: Money): number {
    return this.micros - other.micros;
  }

  greaterThan(other: Money): boolean {
    return this.micros > other.micros;
  }

  lessThan(other: Money): boolean {
    return this.micros < other.micros;
  }

  toNumber(): number {
    return this.micros / Money.SCALE;
  }

  toFixed(decimals = 2): string {
    return this.toNumber().toFixed(decimals);
  }

  static sum(values: Money[]): Money {
    return values.reduce((acc, v) => acc.add(v), Money.zero());
  }

  static max(a: Money, b: Money): Money {
    return a.greaterThan(b) ? a : b;
  }

  static min(a: Money, b: Money): Money {
    return a.lessThan(b) ? a : b;
  }
}
