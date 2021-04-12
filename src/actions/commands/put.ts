import { PositionDiff, sorted } from '../../common/motion/position';
import { configuration } from '../../configuration/configuration';
import { isVisualMode, Mode } from '../../mode/mode';
import { Register, RegisterMode, RegisterContent } from '../../register/register';
import { RecordedState } from '../../state/recordedState';
import { VimState } from '../../state/vimState';
import { TextEditor } from '../../textEditor';
import { reportLinesChanged } from '../../util/statusBarTextUtils';
import { BaseCommand, RegisterAction } from '../base';
import * as operator from '../operator';
import { StatusBar } from '../../statusBar';
import { VimError, ErrorCode } from '../../error';
import { Position } from 'vscode';

/**
 * Flags used for executing PutCommand.
 */
export interface IPutCommandOptions {
  /**
   * Determines whether to put the text before or after the cursor position.
   *
   * True for commands like `P` and `gP`
   */
  pasteBeforeCursor?: boolean;

  /**
   * Adjust the indent of the put to match the current line's indentation.
   *
   * True for commands like `]p` and `[p`
   */
  adjustIndent?: boolean;

  /**
   * True only for `:p[ut]`
   *
   * Forces a linewise register mode put and puts the cursor on the last line of what you pasted.
   */
  exCommand?: boolean;
}

@RegisterAction
export class PutCommand extends BaseCommand {
  keys = ['p'];
  modes = [Mode.Normal];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  constructor(multicursorIndex?: number) {
    super();
    this.multicursorIndex = multicursorIndex;
  }

  public async exec(
    position: Position,
    vimState: VimState,
    options: IPutCommandOptions = {}
  ): Promise<void> {
    const register = await Register.get(vimState.recordedState.registerName, this.multicursorIndex);
    if (register === undefined) {
      StatusBar.displayError(vimState, VimError.fromCode(ErrorCode.NothingInRegister));
      return;
    }

    const registerMode = options.exCommand ? RegisterMode.LineWise : register.registerMode;

    if (register.text instanceof RecordedState) {
      /**
       *  Paste content from recordedState. This one is actually complex as
       *  Vim has internal key code for key strokes.For example, Backspace
       *  is stored as `<80>kb`. So if you replay a macro, which is stored
       *  in a register as `a1<80>kb2`, youshall just get `2` inserted as
       *  `a` represents entering Insert Mode, `<80>bk` represents
       *  Backspace. However here, we shall
       *  insert the plain text content of the register, which is `a1<80>kb2`.
       */
      vimState.recordedState.transformer.addTransformation({
        type: 'macro',
        register: vimState.recordedState.registerName,
        replay: 'keystrokes',
      });
      return;
    } else if (typeof register.text === 'object' && vimState.currentMode === Mode.VisualBlock) {
      await this.execVisualBlockPaste(
        register.text,
        position,
        vimState,
        options.pasteBeforeCursor || false
      );
    }

    // Where we're going to insert the text
    const destination =
      !isVisualMode(vimState.currentMode) && registerMode === RegisterMode.LineWise
        ? options.pasteBeforeCursor
          ? position.getLineBegin()
          : position.getLineEnd()
        : options.pasteBeforeCursor
        ? position
        : position.getRight();

    // Get text from the register
    let text = register.text;
    if (
      !isVisualMode(vimState.currentMode) &&
      registerMode === RegisterMode.LineWise &&
      options.adjustIndent
    ) {
      // Adjust indent to current line
      const indentationWidth = TextEditor.getIndentationLevel(
        vimState.document.lineAt(position).text
      );
      const firstLineIdentationWidth = TextEditor.getIndentationLevel(text.split('\n')[0]);

      text = text
        .split('\n')
        .map((line) => {
          const currentIdentationWidth = TextEditor.getIndentationLevel(line);
          const newIndentationWidth =
            currentIdentationWidth - firstLineIdentationWidth + indentationWidth;

          return TextEditor.setIndentationLevel(line, newIndentationWidth);
        })
        .join('\n');
    }

    // Adjust text with leading and/or trailing newline as needed by linewise register
    const noPrevLine = vimState.cursorStartPosition.line === 0;
    const noNextLine = vimState.cursorStopPosition.line === vimState.document.lineCount - 1;
    let adjustedText = text;
    if (registerMode === RegisterMode.LineWise) {
      if (vimState.currentMode === Mode.Visual) {
        // In the specific case of linewise register data during visual mode, we need extra newline feeds
        adjustedText = '\n' + text + '\n';
      } else if (vimState.currentMode === Mode.VisualLine) {
        // In the specific case of linewise register data during visual mode, we need extra newline feeds
        const left = !noPrevLine && noNextLine ? '\n' : '';
        const right = noNextLine ? '' : '\n';
        adjustedText = left + text + right;
      } else if (options.pasteBeforeCursor) {
        adjustedText = text + '\n';
      } else {
        adjustedText = '\n' + text;
      }
    }

    // After using "p" or "P" in Visual mode the text that was put will be selected (from Vim's ":help gv").
    if (isVisualMode(vimState.currentMode)) {
      let textToEnd = adjustedText;
      if (
        vimState.currentMode === Mode.VisualLine &&
        adjustedText[adjustedText.length - 1] === '\n'
      ) {
        // Don't go to next line due to trailing newline
        textToEnd = adjustedText.substring(0, adjustedText.length - 1);
      }
      vimState.lastVisualSelection = {
        mode: vimState.currentMode,
        start: destination,
        end: destination.advancePositionByText(textToEnd),
      };
    }

    // More vim weirdness: If the thing you're pasting has a newline, the cursor
    // stays in the same place. Otherwise, it moves to the end of what you pasted.

    const numNewlines = text.split('\n').length - 1;
    const currentLineLength = vimState.document.lineAt(position).text.length;

    // Adjust the cursor position using a PositionDiff
    let diff: PositionDiff;
    if (vimState.currentMode === Mode.VisualLine) {
      const lines = text.split('\n');
      const whitespaceOnFirstLine = /^\s*/.exec(lines[0])?.[0].length ?? 0;
      let lineDiff = lines.length - 1;
      if (register.registerMode === RegisterMode.LineWise && !noNextLine) {
        lineDiff++;
      }
      diff = PositionDiff.exactCharacter({
        lineOffset: -lineDiff,
        character: whitespaceOnFirstLine,
      });
    } else if (options.exCommand) {
      // Move to cursor to last line, first non-whitespace character of what you pasted
      const lastLine = text.split('\n')[numNewlines];
      const check = lastLine.match(/^\s*/);
      const numWhitespace = check ? check[0].length : 0;

      let lineDiff: number;
      if (options.pasteBeforeCursor) {
        lineDiff = -numNewlines;
      } else {
        lineDiff = currentLineLength > 0 ? numNewlines + 1 : 0;
      }

      diff = PositionDiff.exactCharacter({
        lineOffset: lineDiff,
        character: numWhitespace,
      });
    } else if (registerMode === RegisterMode.LineWise) {
      const check = text.match(/^\s*/);
      const numWhitespace = check ? check[0].length : 0;

      if (options.pasteBeforeCursor) {
        diff = PositionDiff.exactCharacter({
          lineOffset: -numNewlines - 1,
          character: numWhitespace,
        });
      } else {
        diff = PositionDiff.exactCharacter({
          lineOffset: currentLineLength > 0 ? 1 : -numNewlines,
          character: numWhitespace,
        });
      }
    } else if (!text.includes('\n')) {
      if (!position.isLineEnd()) {
        let characterOffset: number;
        if (registerMode === RegisterMode.BlockWise) {
          characterOffset = options.pasteBeforeCursor ? -text.length : 1;
        } else {
          characterOffset = options.pasteBeforeCursor ? -1 : adjustedText.length;
        }
        diff = PositionDiff.offset({
          character: characterOffset,
        });
      } else {
        diff = PositionDiff.identity();
      }
    } else if (position.isLineEnd()) {
      diff = PositionDiff.exactCharacter({
        lineOffset: -numNewlines,
        character: position.character,
      });
    } else if (options.pasteBeforeCursor) {
      diff = PositionDiff.exactCharacter({
        lineOffset: -numNewlines,
        character: position.character,
      });
    } else {
      diff = PositionDiff.offset({
        character: 1,
      });
    }

    vimState.recordedState.transformer.addTransformation({
      type: 'insertText',
      text: adjustedText,
      position: destination,
      diff,
    });

    // Report lines changed
    let numNewlinesAfterPut = adjustedText.split('\n').length;
    if (registerMode === RegisterMode.LineWise) {
      numNewlinesAfterPut--;
    }
    reportLinesChanged(numNewlinesAfterPut, vimState);

    vimState.currentRegisterMode = registerMode;
  }

  private async execVisualBlockPaste(
    block: string[],
    position: Position,
    vimState: VimState,
    pasteBeforeCursor: boolean
  ): Promise<void> {
    if (pasteBeforeCursor) {
      position = position.getRight();
    }

    // Add empty lines at the end of the document, if necessary.
    const linesToAdd = Math.max(
      0,
      block.length - (vimState.document.lineCount - position.line) + 1
    );
    if (linesToAdd > 0) {
      await TextEditor.insertAt(
        vimState.editor,
        Array(linesToAdd).join('\n'),
        new Position(
          vimState.document.lineCount - 1,
          TextEditor.getLineLength(vimState.document.lineCount - 1)
        )
      );
    }

    // paste the entire block.
    for (let lineIndex = position.line; lineIndex < position.line + block.length; lineIndex++) {
      const line = block[lineIndex - position.line];
      const insertPos = new Position(
        lineIndex,
        Math.min(position.character, TextEditor.getLineLength(lineIndex))
      );

      await TextEditor.insertAt(vimState.editor, line, insertPos);
    }

    vimState.currentRegisterMode = RegisterMode.AscertainFromCurrentMode;
  }

  public async execCount(position: Position, vimState: VimState): Promise<void> {
    const register = await Register.get(vimState.recordedState.registerName, this.multicursorIndex);
    if (register === undefined) {
      StatusBar.displayError(vimState, VimError.fromCode(ErrorCode.NothingInRegister));
      return;
    }

    await super.execCount(position, vimState);

    const count = vimState.recordedState.count || 1;
    if (vimState.effectiveRegisterMode === RegisterMode.LineWise && count > 1) {
      vimState.recordedState.transformer.addTransformation({
        type: 'moveCursor',
        diff: PositionDiff.offset({ line: -count + 1 }),
        cursorIndex: this.multicursorIndex,
      });
    }
  }
}

@RegisterAction
class PutBeforeCommand extends BaseCommand {
  public keys = ['P'];
  public modes = [Mode.Normal];
  canBeRepeatedWithDot = true;
  runsOnceForEachCountPrefix = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await new PutCommand(this.multicursorIndex).exec(position, vimState, {
      pasteBeforeCursor: true,
    });
  }
}

@RegisterAction
class PutCommandVisual extends BaseCommand {
  keys = [['p'], ['P']];
  modes = [Mode.Visual, Mode.VisualLine];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const registerName = vimState.recordedState.registerName;
    const register = await Register.get(registerName, this.multicursorIndex);
    if (register === undefined) {
      StatusBar.displayError(vimState, VimError.fromCode(ErrorCode.NothingInRegister));
      return;
    }

    // TODO: this should be handled by PutCommand, but that will require a larger refactor
    const hasCount = vimState.recordedState.count > 1;
    let oldText: RegisterContent = '';
    if (hasCount) {
      oldText = register.text;

      const repeatedText = Array(vimState.recordedState.count)
        .fill(oldText)
        .join(
          register.registerMode === RegisterMode.LineWise ||
            vimState.currentMode === Mode.VisualLine
            ? '\n'
            : ''
        );

      // Repeat register content requested number of times and save this into the register
      Register.putByKey(registerName, repeatedText, register.registerMode);
      // TODO: are both these lines needed?
      register.text = repeatedText;

      // Only put the register content once as it's repeated in the register
      vimState.recordedState.count = 1;
    }

    let [start, end] = sorted(vimState.cursorStartPosition, vimState.cursorStopPosition);
    if (vimState.currentMode === Mode.VisualLine) {
      [start, end] = [start.getLineBegin(), end.getLineEnd()];
    }

    const oldMode = vimState.currentMode;
    if (register.registerMode === RegisterMode.LineWise) {
      // If the to-be-inserted text is linewise, we have separate logic:
      // first delete the selection, then insert
      vimState.recordedState.registerName = configuration.useSystemClipboard ? '*' : '"';

      // visual paste breaks for multicursor as of november 2020 because of the yank part
      // so we disable it for now, see: https://github.com/VSCodeVim/Vim/issues/5493#issuecomment-731147687
      const yank = !vimState.isMultiCursor;
      await new operator.DeleteOperator(this.multicursorIndex).run(vimState, start, end, yank);

      const deletedRegisterName = vimState.recordedState.registerName;
      const deletedRegister = (await Register.get(deletedRegisterName, this.multicursorIndex))!;
      if (registerName === deletedRegisterName) {
        Register.putByKey(registerName, register.text, register.registerMode);
      }

      // To ensure that the put command knows this is
      // a linewise register insertion in visual mode of
      // characterwise, linewise
      const resultMode = vimState.currentMode;
      await vimState.setCurrentMode(oldMode);
      vimState.recordedState.registerName = registerName;
      await new PutCommand(this.multicursorIndex).exec(start, vimState, {
        pasteBeforeCursor: true,
      });
      await vimState.setCurrentMode(resultMode);

      if (registerName === deletedRegisterName) {
        Register.putByKey(deletedRegisterName, deletedRegister.text, deletedRegister.registerMode);
      }
    } else {
      await new PutCommand(this.multicursorIndex).exec(start, vimState, {
        pasteBeforeCursor: true,
      });

      // Yank (line-wise iff we're in VisualLine mode) into the default register
      vimState.currentRegisterMode =
        oldMode === Mode.VisualLine ? RegisterMode.LineWise : RegisterMode.CharacterWise;
      vimState.recordedState.registerName = configuration.useSystemClipboard ? '*' : '"';
      if (!vimState.isMultiCursor) {
        await new operator.YankOperator(this.multicursorIndex).run(vimState, start, end);
      }

      // Delete, always character-wise
      vimState.currentRegisterMode = RegisterMode.CharacterWise;
      await new operator.DeleteOperator(this.multicursorIndex).run(
        vimState,
        start,
        end.getLeftIfEOL(),
        false
      );

      vimState.currentRegisterMode = RegisterMode.AscertainFromCurrentMode;
    }

    if (hasCount) {
      Register.putByKey(registerName, oldText, register.registerMode);
    }
  }
}

@RegisterAction
class GPutCommand extends BaseCommand {
  keys = ['g', 'p'];
  modes = [Mode.Normal];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await new PutCommand(this.multicursorIndex).exec(position, vimState);
  }

  public async execCount(position: Position, vimState: VimState): Promise<void> {
    const register = await Register.get(vimState.recordedState.registerName, this.multicursorIndex);
    if (register === undefined) {
      StatusBar.displayError(vimState, VimError.fromCode(ErrorCode.NothingInRegister));
      return;
    }

    if (register.text instanceof RecordedState) {
      vimState.recordedState.transformer.addTransformation({
        type: 'macro',
        register: vimState.recordedState.registerName,
        replay: 'keystrokes',
      });

      return;
    }

    await super.execCount(position, vimState);

    if (vimState.effectiveRegisterMode === RegisterMode.LineWise) {
      const addedLinesCount = register.text.split('\n').length;
      vimState.recordedState.transformer.addTransformation({
        type: 'moveCursor',
        diff: PositionDiff.exactCharacter({ lineOffset: addedLinesCount, character: 0 }),
        cursorIndex: this.multicursorIndex,
      });
    }
  }
}

@RegisterAction
class GPutCommandVisual extends PutCommandVisual {
  keys = [
    ['g', 'p'],
    ['g', 'P'],
  ];
  modes = [Mode.Visual, Mode.VisualLine];

  public async exec(position: Position, vimState: VimState): Promise<void> {
    const visualLine = vimState.currentMode === Mode.VisualLine;
    const repeats = vimState.recordedState.count === 0 ? 1 : vimState.recordedState.count;
    await super.exec(position, vimState);
    // Vgp should place the cursor on the next line
    if (visualLine || vimState.effectiveRegisterMode === RegisterMode.LineWise) {
      vimState.recordedState.transformer.addTransformation({
        type: 'moveCursor',
        diff: PositionDiff.offset({ line: repeats, character: 0 }),
        cursorIndex: this.multicursorIndex,
      });
    }
  }
}

@RegisterAction
class GPutBeforeCommand extends BaseCommand {
  keys = ['g', 'P'];
  modes = [Mode.Normal];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await new PutCommand(this.multicursorIndex).exec(position, vimState, {
      pasteBeforeCursor: true,
    });
    const register = await Register.get(vimState.recordedState.registerName, this.multicursorIndex);
    if (register === undefined) {
      StatusBar.displayError(vimState, VimError.fromCode(ErrorCode.NothingInRegister));
      return;
    }

    if (register.text instanceof RecordedState) {
      vimState.recordedState.transformer.addTransformation({
        type: 'macro',
        register: vimState.recordedState.registerName,
        replay: 'keystrokes',
      });

      return;
    }

    if (vimState.effectiveRegisterMode === RegisterMode.LineWise) {
      const addedLinesCount = register.text.split('\n').length;
      vimState.recordedState.transformer.addTransformation({
        type: 'moveCursor',
        diff: PositionDiff.exactCharacter({ lineOffset: addedLinesCount, character: 0 }),
        cursorIndex: this.multicursorIndex,
      });
    }
  }
}

@RegisterAction
class PutWithIndentCommand extends BaseCommand {
  keys = [']', 'p'];
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await new PutCommand(this.multicursorIndex).exec(position, vimState, { adjustIndent: true });
  }
}

@RegisterAction
class PutBeforeWithIndentCommand extends BaseCommand {
  keys = [
    ['[', 'P'],
    [']', 'P'],
    ['[', 'p'],
  ];
  modes = [Mode.Normal];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<void> {
    await new PutCommand(this.multicursorIndex).exec(position, vimState, {
      pasteBeforeCursor: true,
      adjustIndent: true,
    });

    if (vimState.effectiveRegisterMode === RegisterMode.LineWise) {
      vimState.cursorStopPosition = TextEditor.getFirstNonWhitespaceCharOnLine(
        vimState.document,
        vimState.cursorStopPosition.getUp().line
      );
    }
  }
}
