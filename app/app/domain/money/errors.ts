export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export class CurrencyMismatchError extends MoneyError {
  constructor(a: string, b: string) {
    super(`Currency mismatch: cannot operate on "${a}" and "${b}" together.`);
    this.name = "CurrencyMismatchError";
  }
}

export class InvalidMoneyAmountError extends MoneyError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyAmountError";
  }
}

export class InvalidAllocationError extends MoneyError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAllocationError";
  }
}
