import type { SyntaxNode, Tree } from '@lezer/common';
import type {
  CommandDictionary,
  EnumMap,
  FswCommand,
  FswCommandArgument,
  FswCommandArgumentRepeat,
  FswCommandArgumentVarString,
  FswCommandArgumentFixedString,
} from '@nasa-jpl/plandev-ampcs';
import type { EditorView } from '@codemirror/view';
import type { LibrarySequenceSignature, PhoenixContext } from './phoenix.js';

export type TimeTagInfo = { node: SyntaxNode; text: string } | null | undefined;

export type StringArg = FswCommandArgumentVarString | FswCommandArgumentFixedString;

/** A dictionary-backed construct at the cursor: a command call, a telemetry read or a parameter read. */
export type DictionaryItemAt = { kind: 'command' | 'telemetry' | 'parameter'; name: string; node: SyntaxNode };

export type ArgTextDef = {
  argDef?: FswCommandArgument;
  children?: ArgTextDef[];
  node?: SyntaxNode;
  parentArgDef?: FswCommandArgumentRepeat;
  text?: string;
};

/**
 * Collection of utilities used primarily to build the command panel in the Phoenix UI.
 *
 * TODO future work is to generalize this interface s.t. adaptations can better control what's in
 * the panel and don't need to implement all these particular pieces.
 */
export interface CommandInfoMapper {
  /** format string of multiple arguments */
  formatArgumentArray(values: string[], commandNode: SyntaxNode | null): string;

  /** get insert position for missing arguments */
  getArgumentAppendPosition(node: SyntaxNode | null): number | undefined;

  /** gets container of arguments from subtree */
  getArgumentNodeContainer(commandNode: SyntaxNode | null): SyntaxNode | null;

  /** collects argument nodes from sub-tree of this command argument container */
  getArgumentsFromContainer(containerNode: SyntaxNode): SyntaxNode[];

  getByteArrayElements?(node: SyntaxNode | null, arrayText: string): string[] | null;

  /** ascends parse tree to find scope to display in form editor */
  getContainingCommand(node: SyntaxNode | null): SyntaxNode | null;

  /**
   * Optional, for languages where most code is not a command (e.g. Rust): the nearest construct
   * around `node` that the parcel's dictionaries define. When implemented, the panel becomes an
   * "At cursor" inspector that shows these items and stays neutral about everything else.
   */
  getDictionaryItemAt?(node: SyntaxNode | null, view: EditorView, context: PhoenixContext): DictionaryItemAt | null;

  getDefaultValueForArgumentDef(argDef: FswCommandArgument, enumMap: EnumMap): string;

  /** How an enum constant is written as an argument literal. Default: a quoted string (SeqN). */
  formatEnumValue?(symbol: string): string;

  /** finds the node in the parse tree containing the name */
  getNameNode(stepNode: SyntaxNode | null): SyntaxNode | null;

  /**
   * collect variables for populating select box, cursor position is used to limit scope to containing
   * sequence in multiple sequence per file languages
   */
  // Consider filtering by type or allowing adaptation to filter by type
  // not clear at this point what FSW does in terms of type coercion and
  // what variable types are used for enums arguments
  getVariables(docText: string, tree: Tree, cursor: number): string[];

  /** is argument node a variable, false implies literal */
  isArgumentNodeOfVariableType(argNode: SyntaxNode | null): boolean;

  isByteArrayArg(argNode: SyntaxNode | null): boolean;

  /** checks if select list should be used */
  nodeTypeEnumCompatible(node: SyntaxNode | null): boolean;

  /** checks if node has knowable argument types */
  nodeTypeHasArguments(node: SyntaxNode | null): boolean;

  /** checks if numeric argument editor should be displayed */
  nodeTypeNumberCompatible(node: SyntaxNode | null): boolean;

  /** Extracts time tag from a given command node */
  getTimeTagInfo(seqEditorView: EditorView, node: SyntaxNode | null): TimeTagInfo;

  getArgumentInfo(
    commandDef: FswCommand | null,
    seqEditorView: EditorView,
    args: SyntaxNode | null,
    argumentDefs: FswCommandArgument[] | undefined,
    parentArgDef: FswCommandArgumentRepeat | undefined,
    phoenixContext: PhoenixContext,
  ): ArgTextDef[];

  getCommandDef(
    commandDictionary: CommandDictionary | null,
    librarySequences: LibrarySequenceSignature[],
    stemName: string,
  ): FswCommand | null;

  getVariablesInScope(seqEditorView: EditorView, tree: Tree | null, cursorPosition?: number): string[];
}
