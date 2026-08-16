/**
 * 1:1 port of `logic/Scanner.java`.
 *
 * Tokenizes a propositional-logic statement into a token stream, reporting
 * illegal symbols with exact 1-based character offsets, and provides the
 * `reformat()` whitespace normalization pass that assigns canonical character
 * positions to every token (the START token receives position -1, exactly as
 * in Java).
 */

import { ScannerException } from './exceptions.ts';
import {
  Token,
  StartToken,
  EndToken,
  SpaceToken,
  PropositionToken,
  ConstantToken,
  NegationToken,
  ConjunctionToken,
  InclusiveDisjunctionToken,
  ExclusiveDisjunctionToken,
  ConditionalToken,
  BiconditionalToken,
  OpenParenthesisToken,
  CloseParenthesisToken,
} from './tokens.ts';

/** Static symbol table — mirrors the Java static initializer. */
const symbolTable: ReadonlyMap<string, string> = new Map<string, string>([
  ['biconditional1', '<=>'],
  ['biconditional2', '<->'],
  ['close_parenthesis', ')'],
  ['conditional1', '=>'],
  ['conditional2', '->'],
  ['conjunction1', '&'],
  ['conjunction2', '^'],
  ['end', '$'],
  ['exclusive_disjunction', '+'],
  ['inclusive_disjunction', '|'],
  ['negation1', '~'],
  ['negation2', '!'],
  ['open_parenthesis', '('],
  ['space', ' '],
  ['start', '@'],
  ['constant_true', '1'],
  ['constant_false', '0'],
]);

const sym = (key: string): string => symbolTable.get(key)!;

export class Scanner {
  private tokenStream: Token[];
  private i = 0;
  private positionOfFirstBadChar = -1;
  private readonly statement: string;

  private readonly inclusive_disjunction = sym('inclusive_disjunction');
  private readonly open_parenthesis = sym('open_parenthesis');
  private readonly close_parenthesis = sym('close_parenthesis');
  private readonly negation1 = sym('negation1');
  private readonly negation2 = sym('negation2');
  private readonly conjunction1 = sym('conjunction1');
  private readonly conjunction2 = sym('conjunction2');
  private readonly exclusive_disjunction = sym('exclusive_disjunction');
  private readonly conditional1 = sym('conditional1');
  private readonly conditional2 = sym('conditional2');
  private readonly biconditional1 = sym('biconditional1');
  private readonly biconditional2 = sym('biconditional2');
  private readonly space = sym('space');
  private readonly constant_true = sym('constant_true');
  private readonly constant_false = sym('constant_false');

  constructor(statement: string) {
    this.statement = statement;
    this.tokenStream = [];
  }

  public getTokenStream(): Token[] {
    return this.tokenStream;
  }

  public tokenize(): void {
    const statement = this.statement;
    const statementLength = statement.length;
    this.i = 0;
    this.positionOfFirstBadChar = -1;
    let c: string;

    this.tokenStream.push(new StartToken(sym('start')));
    while (this.i < statementLength) {
      c = statement.charAt(this.i);
      if (c === this.inclusive_disjunction.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.tokenStream.push(new InclusiveDisjunctionToken(this.inclusive_disjunction, this.i));
      } else if (c === this.open_parenthesis.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.tokenStream.push(new OpenParenthesisToken(this.open_parenthesis, this.i));
      } else if (c === this.close_parenthesis.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.tokenStream.push(new CloseParenthesisToken(this.close_parenthesis, this.i));
      } else if (c === this.negation1.charAt(0) || c === this.negation2.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.tokenStream.push(new NegationToken(c, this.i));
      } else if (c === this.conjunction1.charAt(0) || c === this.conjunction2.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.tokenStream.push(new ConjunctionToken(c, this.i));
      } else if (c === this.exclusive_disjunction.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.tokenStream.push(new ExclusiveDisjunctionToken(this.exclusive_disjunction, this.i));
      } else if (c === this.constant_false.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.tokenStream.push(new ConstantToken(this.constant_false, this.i, false));
      } else if (c === this.constant_true.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.tokenStream.push(new ConstantToken(this.constant_true, this.i, true));
      } else if (c === this.conditional1.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.scanMultiCharSymbol(this.conditional1, new ConditionalToken(this.conditional1, this.i), true);
      } else if (c === this.conditional2.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.scanMultiCharSymbol(this.conditional2, new ConditionalToken(this.conditional2, this.i), true);
      } else if (c === this.biconditional1.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        const current = this.i;
        const isOK = this.scanMultiCharSymbol(
          this.biconditional1,
          new BiconditionalToken(this.biconditional1, this.i),
          false,
        );
        if (!isOK) {
          this.i = current;
          this.scanMultiCharSymbol(this.biconditional2, new BiconditionalToken(this.biconditional2, this.i), true);
        }
      } else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
        this.tokenStream.push(new PropositionToken(c.toUpperCase(), this.i));
      } else if (c === this.space.charAt(0)) {
        this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, this.i - 1);
      } else if (this.positionOfFirstBadChar === -1) {
        this.positionOfFirstBadChar = this.i;
      }
      this.i++;
    }
    this.positionOfFirstBadChar = this.reportError(this.positionOfFirstBadChar, --this.i);
    this.tokenStream.push(new EndToken(sym('end')));
  }

  /**
   * Java: `Scanner.reformat()` — rebuilds the token stream inserting canonical
   * single spaces, and assigns each token its character position in the
   * reformatted statement (START gets -1).
   */
  public reformat(): void {
    const list = this.tokenStream;
    let iteratorIndex = 0;
    const reformattedtokenStream: Token[] = [];
    let token1: Token | null = null;
    let token2: Token | null = null;
    let position = -1;
    if (iteratorIndex < list.length) {
      token1 = list[iteratorIndex++];
    }
    while (iteratorIndex < list.length) {
      token2 = list[iteratorIndex++];
      const token1Type = token1!.getType();
      const token2Type = token2.getType();
      token1!.setPosition(position);
      reformattedtokenStream.push(token1!);
      position = position + token1!.getSymbol().length;
      if (token1Type === Token.START) {
        if (token2Type === Token.BINARY_OPERATOR) {
          const spaceToken = new SpaceToken(sym('space'), position);
          reformattedtokenStream.push(spaceToken);
          position = position + spaceToken.getSymbol().length;
        }
      } else if (token1Type === Token.BINARY_OPERATOR) {
        const spaceToken = new SpaceToken(sym('space'), position);
        reformattedtokenStream.push(spaceToken);
        position = position + spaceToken.getSymbol().length;
      } else if (token1Type === Token.UNARY_OPERATOR) {
        if (token2Type === Token.BINARY_OPERATOR) {
          const spaceToken = new SpaceToken(sym('space'), position);
          reformattedtokenStream.push(spaceToken);
          position = position + spaceToken.getSymbol().length;
        }
      } else if (
        token1Type === Token.PROPOSITION ||
        token1Type === Token.CONSTANT ||
        token1Type === Token.CLOSE_PARENTHESIS
      ) {
        if (token2Type !== Token.CLOSE_PARENTHESIS && token2Type !== Token.END) {
          const spaceToken = new SpaceToken(sym('space'), position);
          reformattedtokenStream.push(spaceToken);
          position = position + spaceToken.getSymbol().length;
        }
      } else if (token1Type === Token.OPEN_PARENTHESIS) {
        if (token2Type === Token.CLOSE_PARENTHESIS) {
          const spaceToken = new SpaceToken(sym('space'), position);
          reformattedtokenStream.push(spaceToken);
          position = position + spaceToken.getSymbol().length;
        }
      }
      token1 = token2;
    }
    if (token2 !== null) {
      token2.setPosition(position);
      reformattedtokenStream.push(token2);
    }
    this.tokenStream = reformattedtokenStream;
  }

  public getStatement(): string {
    let builder = '';
    for (const token of this.tokenStream) {
      const tokenType = token.getType();
      if (tokenType !== Token.START && tokenType !== Token.END) {
        builder += token.getSymbol();
      }
    }
    return builder;
  }

  private scanMultiCharSymbol(symbol: string, token: Token, isFinalMatch: boolean): boolean {
    this.positionOfFirstBadChar = -1;
    let symbolPos = 1;
    const symbolLength = symbol.length;
    const initialValueOfI = this.i;
    for (;;) {
      this.i++;
      if (this.i >= this.statement.length) {
        if (isFinalMatch) {
          this.positionOfFirstBadChar = this.reportError(initialValueOfI, this.i - 1);
        } else {
          return false;
        }
      }
      const c = this.statement.charAt(this.i);
      if (symbolPos < symbolLength && c === symbol.charAt(symbolPos)) {
        if (symbolPos + 1 === symbolLength) {
          if (this.positionOfFirstBadChar !== -1) {
            if (isFinalMatch) {
              this.positionOfFirstBadChar = this.reportError(initialValueOfI, this.i);
            } else {
              return false;
            }
          }
          this.tokenStream.push(token);
          break;
        }
        symbolPos++;
      } else {
        if (this.positionOfFirstBadChar === -1) {
          this.positionOfFirstBadChar = this.i;
        }
        if (
          c === this.negation1.charAt(0) ||
          c === this.negation2.charAt(0) ||
          c === this.constant_true.charAt(0) ||
          c === this.constant_false.charAt(0) ||
          c === this.space.charAt(0) ||
          c === this.open_parenthesis.charAt(0) ||
          (c >= 'A' && c <= 'Z') ||
          (c >= 'a' && c <= 'z')
        ) {
          this.i--;
          if (isFinalMatch) {
            this.positionOfFirstBadChar = this.reportError(initialValueOfI, this.i);
          } else {
            return false;
          }
        } else {
          symbolPos++;
        }
      }
    }
    return true;
  }

  private reportError(positionOfFirstBadChar: number, positionOfCurrentChar: number): number {
    if (positionOfFirstBadChar !== -1) {
      if (positionOfCurrentChar - positionOfFirstBadChar < 1) {
        throw new ScannerException(ScannerException.ILLEGAL_SYMBOL, positionOfFirstBadChar + 1);
      } else {
        throw new ScannerException(
          ScannerException.ILLEGAL_SYMBOLS,
          positionOfFirstBadChar + 1,
          positionOfCurrentChar + 1,
        );
      }
    }
    return -1;
  }
}
