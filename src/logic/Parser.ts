/**
 * 1:1 port of `logic/Parser.java`.
 *
 * Performs the pairwise syntax validation (with exact 1-based error offsets)
 * and Dijkstra's shunting-yard conversion into a postfix token stream.
 * `removeUnnecessaryParentheses()` is ported verbatim for completeness even
 * though — exactly as in the original `MainInterface` — it is not invoked in
 * the Venn-diagram construction pipeline.
 */

import { ParserException } from './exceptions.ts';
import { Token } from './tokens.ts';

interface Point {
  x: number;
  y: number;
}

export class Parser {
  private tokenStream: Token[];
  private readonly postfixStream: Token[];

  constructor(tokenStream: Token[]) {
    this.tokenStream = tokenStream;
    this.postfixStream = [];
  }

  public getPostfixStream(): Token[] {
    return this.postfixStream;
  }

  public parse(): void {
    let iteratorIndex = 0;
    const stream = this.tokenStream;
    let token1: Token | null = null;
    let token2: Token;
    if (iteratorIndex < stream.length) {
      token1 = stream[iteratorIndex++];
    }
    while (iteratorIndex < stream.length) {
      token2 = stream[iteratorIndex++];
      const token1Type = token1!.getType();
      let token2Type = token2.getType();
      if (token2Type === Token.SPACE) {
        if (iteratorIndex < stream.length) {
          token2 = stream[iteratorIndex++];
          token2Type = token2.getType();
        }
      }
      switch (token1Type) {
        case Token.PROPOSITION:
          if (
            token2Type === Token.PROPOSITION ||
            token2Type === Token.CONSTANT ||
            token2Type === Token.UNARY_OPERATOR ||
            token2Type === Token.OPEN_PARENTHESIS
          ) {
            throw new ParserException(ParserException.MISSING_CONNECTIVE, token1!.getPosition() + 2);
          }
          break;
        case Token.CONSTANT:
          if (
            token2Type === Token.PROPOSITION ||
            token2Type === Token.CONSTANT ||
            token2Type === Token.UNARY_OPERATOR ||
            token2Type === Token.OPEN_PARENTHESIS
          ) {
            throw new ParserException(ParserException.MISSING_CONNECTIVE, token1!.getPosition() + 2);
          }
          break;
        case Token.UNARY_OPERATOR:
          if (
            token2Type === Token.CLOSE_PARENTHESIS ||
            token2Type === Token.BINARY_OPERATOR ||
            token2Type === Token.END
          ) {
            throw new ParserException(ParserException.MISSING_STATEMENT, token1!.getPosition() + 2);
          }
          break;
        case Token.OPEN_PARENTHESIS:
          if (token2Type === Token.CLOSE_PARENTHESIS) {
            throw new ParserException(
              ParserException.MISSING_STATEMENT_IN_PARENTHESES,
              token1!.getPosition() + 2,
            );
          } else if (token2Type === Token.BINARY_OPERATOR) {
            throw new ParserException(ParserException.MISSING_STATEMENT, token1!.getPosition() + 2);
          } else if (token2Type === Token.END) {
            throw new ParserException(ParserException.ILLEGAL_USE_OF_PARENTHESES, token1!.getPosition() + 1);
          }
          break;
        case Token.CLOSE_PARENTHESIS:
          if (
            token2Type === Token.PROPOSITION ||
            token2Type === Token.CONSTANT ||
            token2Type === Token.UNARY_OPERATOR ||
            token2Type === Token.OPEN_PARENTHESIS
          ) {
            throw new ParserException(ParserException.MISSING_CONNECTIVE, token1!.getPosition() + 2);
          }
          break;
        case Token.BINARY_OPERATOR:
          if (
            token2Type === Token.CLOSE_PARENTHESIS ||
            token2Type === Token.BINARY_OPERATOR ||
            token2Type === Token.END
          ) {
            throw new ParserException(
              ParserException.MISSING_STATEMENT,
              token1!.getPosition() + token1!.getSymbol().length + 1,
            );
          }
          break;
        case Token.START:
          if (token2Type === Token.CLOSE_PARENTHESIS) {
            throw new ParserException(ParserException.ILLEGAL_USE_OF_PARENTHESES, token1!.getPosition() + 2);
          } else if (token2Type === Token.BINARY_OPERATOR) {
            throw new ParserException(ParserException.MISSING_STATEMENT, token1!.getPosition() + 2);
          }
          break;
        default:
          break;
      }
      token1 = token2;
    }
    this.computePostfixStream();
  }

  private computePostfixStream(): void {
    const stack: Token[] = [];
    const stream = this.tokenStream;
    let iteratorIndex = 0;
    let token: Token;
    let stackTop: Token | null = null;

    while (iteratorIndex < stream.length) {
      do {
        token = stream[iteratorIndex++];
      } while (iteratorIndex < stream.length && token.getType() === Token.SPACE);
      if (stack.length !== 0) {
        stackTop = stack[stack.length - 1];
      }
      const tokenType = token.getType();
      if (tokenType !== Token.START && tokenType !== Token.END) {
        if (tokenType === Token.PROPOSITION || tokenType === Token.CONSTANT) {
          this.postfixStream.push(token);
        } else if (tokenType === Token.OPEN_PARENTHESIS) {
          stack.push(token);
        } else if (tokenType === Token.CLOSE_PARENTHESIS) {
          while (stack.length !== 0 && stackTop!.getType() !== Token.OPEN_PARENTHESIS) {
            this.postfixStream.push(stack.pop()!);
            if (stack.length !== 0) {
              stackTop = stack[stack.length - 1];
            }
          }
          if (stack.length === 0) {
            throw new ParserException(ParserException.MISSING_OPEN_PARENTHESIS, true);
          } else {
            stack.pop();
          }
        } else if (stack.length === 0) {
          stack.push(token);
        } else if (tokenType === Token.UNARY_OPERATOR && stackTop!.getPrecedence() <= token.getPrecedence()) {
          stack.push(token);
        } else if (stackTop!.getPrecedence() < token.getPrecedence()) {
          stack.push(token);
        } else if (stackTop!.isConditional() && token.isConditional()) {
          stack.push(token);
        } else {
          while (stack.length !== 0 && stackTop!.getPrecedence() >= token.getPrecedence()) {
            this.postfixStream.push(stack.pop()!);
            if (stack.length !== 0) {
              stackTop = stack[stack.length - 1];
            }
          }
          stack.push(token);
        }
      }
    }
    while (stack.length !== 0) {
      token = stack.pop()!;
      if (token.getType() !== Token.OPEN_PARENTHESIS) {
        this.postfixStream.push(token);
      } else {
        throw new ParserException(ParserException.MISSING_CLOSE_PARENTHESIS, true);
      }
    }
  }

  /**
   * Verbatim port of `Parser.removeUnnecessaryParentheses()` (unused by the
   * Venn pipeline, kept for full API parity with the Java class).
   */
  public removeUnnecessaryParentheses(): void {
    let tokenArray: (Token | null)[] = new Array<Token | null>(this.tokenStream.length);
    const newTokenStream: Token[] = [];
    let pos = 0;
    for (const t of this.tokenStream) {
      tokenArray[pos++] = t;
    }
    const stack: number[] = [];
    const parensMatchings: Point[] = [];

    pos = 0;
    for (const token of this.tokenStream) {
      if (token.getType() === Token.OPEN_PARENTHESIS) {
        stack.push(pos);
      } else if (token.getType() === Token.CLOSE_PARENTHESIS) {
        parensMatchings.push({ x: stack.pop()!, y: pos });
      }
      pos++;
    }
    parensMatchings.sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));
    for (let i = 0; i < parensMatchings.length; i++) {
      let removalRequired = false;
      const p = parensMatchings[i];
      const propositionCount = this.getPropositionCountInsideParens(tokenArray, p.x, p.y);
      if (propositionCount <= 1) {
        // If there's only one proposition inside the parentheses,
        // then the parentheses are clearly not needed.
        removalRequired = true;
      } else if (p.x === 1 && p.y === tokenArray.length - 2) {
        // If these parentheses surround the whole statement, then
        // they can definitely be removed.
        removalRequired = true;
      } else {
        // Check if these parentheses are duplicates, that is, they surround
        // another set of parentheses.
        if (i < parensMatchings.length - 1) {
          const pLookAhead = parensMatchings[i + 1];
          if (pLookAhead.y === p.y - 1) {
            if (pLookAhead.x === p.x + 1) {
              // Direct duplicates
              removalRequired = true;
            } else {
              // Duplicates surrounding a negation
              let isDuplicateParens = true;
              for (let c = p.x + 1; c < pLookAhead.x; c++) {
                const t = tokenArray[c];
                if (t!.getType() !== Token.UNARY_OPERATOR) {
                  isDuplicateParens = false;
                  break;
                }
              }
              removalRequired = isDuplicateParens;
            }
          }
        }
      }
      // If parentheses surround only one proposition, surround the whole
      // statement, or are duplicates, remove them.
      if (removalRequired) {
        tokenArray[p.x] = null;
        tokenArray[p.y] = null;

        for (let j = i + 1; j < parensMatchings.length; j++) {
          const p2 = parensMatchings[j];
          if (p.x < p2.x) p2.x--;
          if (p.x < p2.y) p2.y--;
          if (p.y < p2.x) p2.x--;
          if (p.y < p2.y) p2.y--;
        }
        for (let j = p.x + 1; j < tokenArray.length; j++) {
          const t = tokenArray[j];
          if (t !== null) {
            const tPos = t.getPosition();
            if (tPos >= p.x) t.setPosition(tPos - 1);
            if (tPos >= p.y) t.setPosition(tPos - 2);
          }
        }
        pos = 0;
        const tempArray: (Token | null)[] = new Array<Token | null>(tokenArray.length - 2);
        for (let j = 0; j < tokenArray.length; j++) {
          const t = tokenArray[j];
          if (t !== null) tempArray[pos++] = t;
        }
        tokenArray = tempArray;
      }
    }
    for (let i = 0; i < tokenArray.length; i++) {
      newTokenStream.push(tokenArray[i]!);
    }
    this.tokenStream = newTokenStream;
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

  private getPropositionCountInsideParens(tokenArray: (Token | null)[], start: number, end: number): number {
    let propositionCount = 0;
    let i = start;
    while (i <= end) {
      const token = tokenArray[i];
      const tokenType = token!.getType();
      if (tokenType === Token.PROPOSITION || tokenType === Token.CONSTANT) {
        propositionCount++;
      }
      i++;
    }
    return propositionCount;
  }
}
