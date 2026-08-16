/**
 * 1:1 port of `logic/TruthTable.java`.
 *
 * Evaluates the postfix stream over all 2^N rows via bit-shift binary
 * formatting, computes the operator column positions (the last one being the
 * main connective column), renders per-row result strings, and classifies the
 * statement as Tautology / Identity / Conditional / Contradiction.
 *
 * The Java quirk is preserved on purpose: with the T/F display method an
 * always-true statement is a "Tautology", with the 0/1 display method the very
 * same statement is called an "Identity" (see `getEvaluation()`).
 */

import { Token, ValueToken, ConstantToken, isUnaryEvaluator, isBinaryEvaluator } from './tokens.ts';
import { TruthValue } from './TruthValue.ts';

export class TruthTable {
  public static readonly UNDEFINED = -1;
  public static readonly TAUTOLOGY = 0;
  public static readonly IDENTITY = 1;
  public static readonly CONDITIONAL = 2;
  public static readonly CONTRADICTION = 3;
  public static readonly EVALUATION_DEFINITION: string[] = [
    'Tautology',
    'Identity',
    'Conditional',
    'Contradiction',
  ];

  private numberOfPropositions = 0;
  private numberOfOperators = 0;
  private readonly displayMethod: number;
  private readonly numberOfLines: number;
  private readonly alphabetizePropositions: boolean;
  private arePositionsCalculated: boolean;
  private readonly postfixStream: Token[];
  private readonly propositionNamesVector: string[];
  private readonly propositionNamesToPositionsMap: Map<string, number>;
  private readonly infixStatement: string;
  private readonly operatorPositions: number[];

  constructor(
    infixStatement: string,
    postfixStream: Token[],
    displayMethod: number,
    alphabetizePropositions: boolean,
  ) {
    this.infixStatement = infixStatement;
    this.postfixStream = postfixStream;
    this.displayMethod = displayMethod;
    this.alphabetizePropositions = alphabetizePropositions;
    this.arePositionsCalculated = false;
    this.propositionNamesVector = [];
    this.propositionNamesToPositionsMap = new Map<string, number>();
    this.extractPropositionData();
    this.operatorPositions = new Array<number>(this.numberOfOperators).fill(0);
    this.numberOfLines = Math.pow(2, this.numberOfPropositions);
  }

  public getStatement(): string {
    return this.infixStatement;
  }

  public getNumberOfLines(): number {
    return this.numberOfLines;
  }

  public getNumberOfColumns(): number {
    this.getPositionOfMainColumn();
    let numberOfColumns = this.operatorPositions.length;
    if (numberOfColumns === 0) {
      numberOfColumns = 1;
    }
    return numberOfColumns;
  }

  public getNumberOfPropositions(): number {
    return this.numberOfPropositions;
  }

  public getPropositionNames(): string[] {
    return this.propositionNamesVector.slice();
  }

  public getDisplayMethod(): number {
    return this.displayMethod;
  }

  /** Read-only view of the operator (connective) column positions. */
  public getOperatorPositions(): number[] {
    return this.operatorPositions.slice();
  }

  public getHeaderSeparator(): string {
    let builder = '';
    for (let i = 0; i < this.numberOfPropositions; i++) {
      builder += '-';
      const propositionLength = this.propositionNamesVector[i].length;
      for (let j = 0; j < propositionLength; j++) {
        builder += '-';
      }
      builder += '-+';
    }
    const infixLengthWithPadding = this.infixStatement.length + 2;
    for (let i = 0; i < infixLengthWithPadding; i++) {
      builder += '-';
    }
    return builder;
  }

  public getHeader(isForTextVersion: boolean): string {
    let builder = '';
    for (let i = 0; i < this.numberOfPropositions; i++) {
      builder += ' ';
      builder += this.propositionNamesVector[i];
      builder += ' ';
      if (isForTextVersion) {
        builder += '|';
      }
    }
    builder += ' ';
    builder += this.infixStatement;
    builder += ' ';
    return builder;
  }

  public getPositionOfMainColumn(): number {
    const binaryPropositionValue = this.getBinaryFormat(0);
    const substitutedPostfix = this.substituteTruthValues(binaryPropositionValue);
    this.evaluatePostfix(substitutedPostfix);

    if (this.operatorPositions.length !== 0) {
      return this.operatorPositions[this.operatorPositions.length - 1];
    } else {
      return 0;
    }
  }

  public getEvaluation(): number {
    let pos: number;
    let result: number;
    let i = 0;
    const upperBound = Math.floor(this.numberOfLines / 2);
    const oneLess = this.numberOfLines - 1;
    let ch: string;
    let done = false;
    const row = this.computeRow(0);

    if (this.operatorPositions.length !== 0) {
      pos = this.operatorPositions[this.operatorPositions.length - 1];
    } else {
      pos = 0;
    }
    ch = row.charAt(pos);

    if (ch === 'T') {
      result = TruthTable.TAUTOLOGY;
    } else if (ch === '1') {
      result = TruthTable.IDENTITY;
    } else {
      result = TruthTable.CONTRADICTION;
    }

    while (i < upperBound) {
      if (this.computeRow(i).charAt(pos) === ch && this.computeRow(oneLess - i).charAt(pos) === ch) {
        i += 1;
      } else {
        done = true;
        break;
      }
    }

    if (!done) {
      return result;
    } else {
      return TruthTable.CONDITIONAL;
    }
  }

  public computeRow(index: number): string;
  public computeRow(index: number, maxColumn: number): string;
  public computeRow(index: number, maxColumn?: number): string {
    if (maxColumn === undefined) {
      const binaryPropositionValues = this.getBinaryFormat(index);
      const substitutedPostfix = this.substituteTruthValues(binaryPropositionValues);
      return this.evaluatePostfix(substitutedPostfix);
    }
    const rowString = this.computeRow(index);
    const rowCharArray: string[] = new Array<string>(rowString.length);
    for (let i = rowString.length - 1; i >= 0; i--) {
      rowCharArray[i] = rowString.charAt(i);
    }
    const length = this.operatorPositions.length;
    if (maxColumn === -1 && length === 0) {
      rowCharArray[0] = ' ';
    } else {
      for (let i = maxColumn + 1; i < this.operatorPositions.length; i++) {
        rowCharArray[this.operatorPositions[i]] = ' ';
      }
    }
    return rowCharArray.join('');
  }

  public getColumnInfoHeight(): number {
    this.computeRow(0);
    let height = 2;
    if (this.operatorPositions !== null && this.operatorPositions.length > 0) {
      height += Math.floor(Math.log10(this.operatorPositions.length));
    }
    return height;
  }

  public getColumnOrderStrings(currentColumn: number): string[] {
    if (currentColumn > this.operatorPositions.length - 1) {
      currentColumn = this.operatorPositions.length - 1;
    }
    const columnOrderStrings: string[] = new Array<string>(this.getColumnInfoHeight());
    if (this.operatorPositions.length === 0) {
      columnOrderStrings[0] = '^ ';
      columnOrderStrings[1] = '1 ';
    } else {
      const charArray: string[][] = [];
      for (let i = 0; i < columnOrderStrings.length; i++) {
        charArray.push(new Array<string>(this.infixStatement.length + 1).fill(' '));
      }
      for (let i = currentColumn; i >= 0; i--) {
        const valueString = String(i + 1);
        const valueLength = valueString.length;
        charArray[0][this.operatorPositions[i]] = '^';
        for (let j = valueLength - 1; j >= 0; j--) {
          charArray[columnOrderStrings.length - valueLength + j][this.operatorPositions[i]] =
            valueString.charAt(j);
        }
      }
      for (let i = charArray.length - 1; i >= 0; i--) {
        columnOrderStrings[i] = charArray[i].join('');
      }
    }
    return columnOrderStrings;
  }

  private extractPropositionData(): void {
    for (const token of this.postfixStream) {
      const tokenType = token.getType();
      if (tokenType === Token.PROPOSITION) {
        const tokenSymbol = token.getSymbol();
        if (!this.propositionNamesToPositionsMap.has(tokenSymbol)) {
          // This method needs to be revisited if we allow propositions
          // to be greater than 1 character in length.
          this.propositionNamesVector.push(tokenSymbol);
          this.propositionNamesToPositionsMap.set(tokenSymbol, 0);
          this.numberOfPropositions++;
        }
      } else if (tokenType === Token.UNARY_OPERATOR || tokenType === Token.BINARY_OPERATOR) {
        this.numberOfOperators++;
      }
    }
    if (this.alphabetizePropositions) {
      this.propositionNamesVector.sort();
    }
    let tokenSymbol: string;
    for (let i = 0; i < this.numberOfPropositions; i++) {
      tokenSymbol = this.propositionNamesVector[i];
      this.propositionNamesToPositionsMap.set(tokenSymbol, i);
    }
  }

  public getBinaryFormat(n: number): boolean[] {
    let base = this.numberOfLines >> 1;
    const binary: boolean[] = new Array<boolean>(this.numberOfPropositions).fill(false);
    for (let i = 0; i < this.numberOfPropositions; i++) {
      const temp = n - base;
      if (temp >= 0) {
        n = temp;
        binary[i] = true;
      }
      base >>= 1;
    }
    return binary;
  }

  private substituteTruthValues(binary: boolean[]): Token[] {
    const substitutedPostfix: Token[] = [];
    for (const token of this.postfixStream) {
      const tokenType = token.getType();
      if (tokenType === Token.PROPOSITION) {
        const i = this.propositionNamesToPositionsMap.get(token.getSymbol())!;
        substitutedPostfix.push(new ValueToken(binary[i], this.displayMethod, token.getPosition()));
      } else if (tokenType === Token.CONSTANT) {
        const constantToken = token as ConstantToken;
        substitutedPostfix.push(
          new ValueToken(constantToken.getValue(), this.displayMethod, token.getPosition()),
        );
      } else {
        substitutedPostfix.push(token);
      }
    }
    return substitutedPostfix;
  }

  private evaluatePostfix(postfixStream: Token[]): string {
    const charArray: string[] = new Array<string>(this.infixStatement.length).fill(' ');
    const stack: Token[] = [];
    let pos = 0;

    for (let k = 0; k < postfixStream.length; k++) {
      const token = postfixStream[k];
      const hasNext = k < postfixStream.length - 1;
      const tokenType = token.getType();
      if (tokenType === Token.BINARY_OPERATOR) {
        const stackPopped2 = stack.pop() as ValueToken;
        const stackPopped1 = stack.pop() as ValueToken;
        if (!isBinaryEvaluator(token)) throw new Error('unreachable');
        const valueToken = token.evaluate(stackPopped1, stackPopped2);
        if (hasNext) {
          stack.push(valueToken);
        }
        charArray[valueToken.getPosition()] = valueToken.getSymbol().charAt(0);
        if (!this.arePositionsCalculated) {
          this.operatorPositions[pos++] = token.getPosition() + token.getOffset();
        }
      } else if (tokenType === Token.UNARY_OPERATOR) {
        const stackPopped = stack.pop() as ValueToken;
        if (!isUnaryEvaluator(token)) throw new Error('unreachable');
        const valueToken = token.evaluate(stackPopped);
        if (hasNext) {
          stack.push(valueToken);
        }
        charArray[valueToken.getPosition()] = valueToken.getSymbol().charAt(0);
        if (!this.arePositionsCalculated) {
          this.operatorPositions[pos++] = token.getPosition() + token.getOffset();
        }
      } else {
        stack.push(token);
      }
    }
    if (stack.length !== 0) {
      const stackPopped = stack.pop() as ValueToken;
      charArray[stackPopped.getPosition()] = TruthValue.getTruthValueString(
        stackPopped.getValue(),
        this.displayMethod,
      ).charAt(0);
    }
    this.arePositionsCalculated = true;
    return charArray.join('');
  }
}
