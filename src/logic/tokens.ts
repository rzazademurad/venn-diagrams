/**
 * 1:1 ports of `logic/Token.java` and every token subclass:
 * StartToken, EndToken, SpaceToken, PropositionToken, ConstantToken,
 * ValueToken, NegationToken, ConjunctionToken, InclusiveDisjunctionToken,
 * ExclusiveDisjunctionToken, ConditionalToken, BiconditionalToken,
 * OpenParenthesisToken, CloseParenthesisToken, plus the UnaryEvaluator and
 * BinaryEvaluator interfaces.
 *
 * NOTE ON PRECEDENCES — these are the exact values from the Java source
 * (which is the authority for 1:1 parity):
 *
 *   NegationToken             ~ !    6
 *   ConjunctionToken          & ^    5
 *   InclusiveDisjunctionToken |      4
 *   ConditionalToken          => ->  3   (right-associative via isConditional)
 *   ExclusiveDisjunctionToken +      2
 *   BiconditionalToken        <=> <->2
 *   OpenParenthesisToken      (      1
 *   CloseParenthesisToken     )      0
 */

import { TruthValue } from './TruthValue.ts';

export abstract class Token {
  public static readonly UNARY_OPERATOR = 0;
  public static readonly BINARY_OPERATOR = 1;
  public static readonly PROPOSITION = 2;
  public static readonly OPEN_PARENTHESIS = 3;
  public static readonly CLOSE_PARENTHESIS = 4;
  public static readonly SPACE = 5;
  public static readonly START = 6;
  public static readonly END = 7;
  public static readonly VALUE = 8;
  public static readonly CONSTANT = 9;

  protected position = 0;
  protected offset = 0;
  protected type = 0;
  protected symbol = '';
  protected _isConditional = false;

  public abstract getPrecedence(): number;

  public getPosition(): number {
    return this.position;
  }

  public setPosition(position: number): void {
    this.position = position;
  }

  public getOffset(): number {
    return this.offset;
  }

  public getType(): number {
    return this.type;
  }

  public getSymbol(): string {
    return this.symbol;
  }

  public isConditional(): boolean {
    return this._isConditional;
  }
}

/* --------------------------- evaluator interfaces ------------------------ */

export interface UnaryEvaluator {
  evaluate(token: ValueToken): ValueToken;
}

export interface BinaryEvaluator {
  evaluate(token1: ValueToken, token2: ValueToken): ValueToken;
}

export function isUnaryEvaluator(t: Token): t is Token & UnaryEvaluator {
  return t.getType() === Token.UNARY_OPERATOR;
}

export function isBinaryEvaluator(t: Token): t is Token & BinaryEvaluator {
  return t.getType() === Token.BINARY_OPERATOR;
}

/* ------------------------------ plain tokens ----------------------------- */

export class StartToken extends Token {
  constructor(symbol: string) {
    super();
    this.type = Token.START;
    this.symbol = symbol;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 0;
  }
}

export class EndToken extends Token {
  constructor(symbol: string) {
    super();
    this.type = Token.END;
    this.symbol = symbol;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 0;
  }
}

export class SpaceToken extends Token {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.SPACE;
    this.symbol = symbol;
    this.position = position;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 0;
  }
}

export class PropositionToken extends Token {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.PROPOSITION;
    this.symbol = symbol;
    this.position = position;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 0;
  }
}

export class ConstantToken extends Token {
  private readonly value: boolean;

  constructor(symbol: string, position: number, value: boolean) {
    super();
    this.type = Token.CONSTANT;
    this.symbol = symbol;
    this.position = position;
    this.value = value;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 0;
  }
  public getValue(): boolean {
    return this.value;
  }
}

export class ValueToken extends Token {
  private readonly value: boolean;
  private readonly displayMethod: number;

  constructor(value: boolean, displayMethod: number, position?: number) {
    super();
    this.type = Token.VALUE;
    this.value = value;
    this.displayMethod = displayMethod;
    this.symbol = TruthValue.getTruthValueString(value, displayMethod);
    this.offset = Math.floor((this.symbol.length - 1) / 2);
    if (position !== undefined) {
      this.position = position;
    }
  }
  public getPrecedence(): number {
    return 0;
  }
  public getValue(): boolean {
    return this.value;
  }
  public getDisplayMethod(): number {
    return this.displayMethod;
  }
}

export class OpenParenthesisToken extends Token {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.OPEN_PARENTHESIS;
    this.symbol = symbol;
    this.position = position;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 1;
  }
}

export class CloseParenthesisToken extends Token {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.CLOSE_PARENTHESIS;
    this.symbol = symbol;
    this.position = position;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 0;
  }
}

/* ----------------------------- operator tokens --------------------------- */

export class NegationToken extends Token implements UnaryEvaluator {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.UNARY_OPERATOR;
    this.symbol = symbol;
    this.position = position;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 6;
  }
  public evaluate(token: ValueToken): ValueToken {
    let returnToken: ValueToken;
    if (token.getValue() === false) {
      returnToken = new ValueToken(true, token.getDisplayMethod(), this.position + this.offset);
    } else {
      returnToken = new ValueToken(false, token.getDisplayMethod(), this.position + this.offset);
    }
    return returnToken;
  }
}

export class ConjunctionToken extends Token implements BinaryEvaluator {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.BINARY_OPERATOR;
    this.symbol = symbol;
    this.position = position;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 5;
  }
  public evaluate(token1: ValueToken, token2: ValueToken): ValueToken {
    let returnToken: ValueToken;
    const token1Value = token1.getValue();
    if (token1Value === token2.getValue()) {
      returnToken = new ValueToken(token1Value, token1.getDisplayMethod(), this.position + this.offset);
    } else {
      returnToken = new ValueToken(false, token1.getDisplayMethod(), this.position + this.offset);
    }
    return returnToken;
  }
}

export class InclusiveDisjunctionToken extends Token implements BinaryEvaluator {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.BINARY_OPERATOR;
    this.symbol = symbol;
    this.position = position;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 4;
  }
  public evaluate(token1: ValueToken, token2: ValueToken): ValueToken {
    let returnToken: ValueToken;
    if (token1.getValue() === false && token2.getValue() === false) {
      returnToken = new ValueToken(false, token1.getDisplayMethod(), this.position + this.offset);
    } else {
      returnToken = new ValueToken(true, token1.getDisplayMethod(), this.position + this.offset);
    }
    return returnToken;
  }
}

export class ExclusiveDisjunctionToken extends Token implements BinaryEvaluator {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.BINARY_OPERATOR;
    this.symbol = symbol;
    this.position = position;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 2;
  }
  public evaluate(token1: ValueToken, token2: ValueToken): ValueToken {
    let returnToken: ValueToken;
    if (token1.getValue() === token2.getValue()) {
      returnToken = new ValueToken(false, token1.getDisplayMethod(), this.position + this.offset);
    } else {
      returnToken = new ValueToken(true, token1.getDisplayMethod(), this.position + this.offset);
    }
    return returnToken;
  }
}

export class ConditionalToken extends Token implements BinaryEvaluator {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.BINARY_OPERATOR;
    this.symbol = symbol;
    this.position = position;
    this._isConditional = true;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 3;
  }
  public evaluate(token1: ValueToken, token2: ValueToken): ValueToken {
    let returnToken: ValueToken;
    if (token1.getValue() === true && token2.getValue() === false) {
      returnToken = new ValueToken(false, token1.getDisplayMethod(), this.position + this.offset);
    } else {
      returnToken = new ValueToken(true, token1.getDisplayMethod(), this.position + this.offset);
    }
    return returnToken;
  }
}

export class BiconditionalToken extends Token implements BinaryEvaluator {
  constructor(symbol: string, position: number) {
    super();
    this.type = Token.BINARY_OPERATOR;
    this.symbol = symbol;
    this.position = position;
    this.offset = Math.floor((symbol.length - 1) / 2);
  }
  public getPrecedence(): number {
    return 2;
  }
  public evaluate(token1: ValueToken, token2: ValueToken): ValueToken {
    let returnToken: ValueToken;
    if (token1.getValue() === token2.getValue()) {
      returnToken = new ValueToken(true, token1.getDisplayMethod(), this.position + this.offset);
    } else {
      returnToken = new ValueToken(false, token1.getDisplayMethod(), this.position + this.offset);
    }
    return returnToken;
  }
}
