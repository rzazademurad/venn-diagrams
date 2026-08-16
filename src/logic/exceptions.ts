/**
 * 1:1 ports of `logic/TruthTableException.java`, `logic/ScannerException.java`
 * and `logic/ParserException.java`.
 *
 * All character positions carried by these errors are 1-based, exactly as in
 * the Java implementation (`@X` / `@Y` in the message templates).
 */

export abstract class TruthTableException extends Error {
  public messageType: number;

  protected constructor(message: string, messageType: number) {
    super(message);
    this.messageType = messageType;
  }

  /** Java: `public String getMessage()` */
  public getMessage(): string {
    return this.message;
  }
}

/* ------------------------------------------------------------------------ */

export class ScannerException extends TruthTableException {
  public static readonly UNKNOWN_ERROR = 0;
  public static readonly ILLEGAL_SYMBOL = 1;
  public static readonly ILLEGAL_SYMBOLS = 2;

  public static readonly messageTable: string[] = [
    'An unknown error occurred while scanning the statement.',
    'Illegal symbol at position @X.',
    'Illegal symbol from positions @X to @Y.',
  ];

  private xValue = -1;
  private yValue = -1;

  /**
   * Mirrors the three Java constructors:
   *   ScannerException()
   *   ScannerException(messageType, xValue)
   *   ScannerException(messageType, xValue, yValue)
   */
  constructor(messageType?: number, xValue?: number, yValue?: number) {
    if (messageType === undefined) {
      super(ScannerException.messageTable[0], ScannerException.UNKNOWN_ERROR);
      return;
    }
    let message = ScannerException.messageTable[messageType];
    if (xValue !== undefined) {
      message = message.replace('@X', String(xValue));
    }
    super(message, messageType);
    this.name = 'ScannerException';
    if (xValue !== undefined) {
      this.xValue = xValue;
      this.yValue = xValue;
    }
    if (yValue !== undefined) {
      this.message = this.message.replace('@Y', String(yValue));
      this.yValue = yValue;
    }
  }

  public getXValue(): number {
    return this.xValue;
  }

  public getYValue(): number {
    return this.yValue;
  }
}

/* ------------------------------------------------------------------------ */

export class ParserException extends TruthTableException {
  public static readonly UNKNOWN_ERROR = 0;
  public static readonly MISSING_CONNECTIVE = 1;
  public static readonly MISSING_STATEMENT = 2;
  public static readonly MISSING_STATEMENT_IN_PARENTHESES = 3;
  public static readonly ILLEGAL_USE_OF_PARENTHESES = 4;
  public static readonly MISSING_OPEN_PARENTHESIS = 5;
  public static readonly MISSING_CLOSE_PARENTHESIS = 6;

  public static readonly messageTable: string[] = [
    'An unknown error occurred while parsing the expression.',
    'Missing connective at position @X.',
    'Missing statement at position @X.',
    'Missing statement inside parentheses at position @X.',
    'Illegal use of parentheses at position @X.',
    'Missing opening parenthesis.',
    'Missing closing parenthesis.',
  ];

  private xValue = -1;
  private _selectAll = false;

  /**
   * Mirrors the four Java constructors:
   *   ParserException()
   *   ParserException(messageType)
   *   ParserException(messageType, xValue)
   *   ParserException(messageType, selectAll)
   */
  constructor(messageType?: number, xValueOrSelectAll?: number | boolean) {
    if (messageType === undefined) {
      super(ParserException.messageTable[0], ParserException.UNKNOWN_ERROR);
      return;
    }
    let message = ParserException.messageTable[messageType];
    if (typeof xValueOrSelectAll === 'number') {
      message = message.replace('@X', String(xValueOrSelectAll));
    }
    super(message, messageType);
    this.name = 'ParserException';
    if (typeof xValueOrSelectAll === 'number') {
      this.xValue = xValueOrSelectAll;
    } else if (typeof xValueOrSelectAll === 'boolean') {
      this._selectAll = xValueOrSelectAll;
    }
  }

  public getXValue(): number {
    return this.xValue;
  }

  public selectAll(): boolean {
    return this._selectAll;
  }
}
