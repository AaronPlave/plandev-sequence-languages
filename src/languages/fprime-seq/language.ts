import { LanguageSupport, syntaxTree } from '@codemirror/language';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { SyntaxNode, Tree } from '@lezer/common';
import { styleTags, tags as t } from '@lezer/highlight';
import type {
  CommandDictionary,
  EnumMap,
  FswCommand,
  FswCommandArgument,
  FswCommandArgumentRepeat,
} from '@nasa-jpl/plandev-ampcs';
import type { EditorView } from '@codemirror/view';
import type { ArgTextDef, CommandInfoMapper, TimeTagInfo } from '../../interfaces/command-info-mapper.js';
import type { InputLanguage } from '../../interfaces/language.js';
import type { LibrarySequenceSignature, PhoenixContext, PhoenixResources } from '../../interfaces/phoenix.js';
import { isFswCommandArgumentRepeat } from '../../utils/sequence-utils.js';
import { parser } from './fprime-seq.grammar.js';
import { fprimeSeqArgDefault, validateFprimeSeq } from './fprime-seq-validate.js';

export const fprimeSeqParser = parser;

export function getFprimeSeqLRLanguage(resources: PhoenixResources) {
  return resources.LRLanguage.define({
    languageData: { commentTokens: { line: ';' } },
    parser: fprimeSeqParser.configure({
      props: [
        styleTags({
          Boolean: t.bool,
          Comment: t.lineComment,
          'Enum/Identifier': t.constant(t.variableName),
          'MemberName/Identifier': t.propertyName,
          Number: t.number,
          'Stem/Identifier': t.keyword,
          String: t.string,
          TimeTag: t.className,
          '[ ]': t.squareBracket,
          '{ }': t.brace,
        }),
      ],
    }),
  });
}

function commandSnippet(command: FswCommand, enumMap: EnumMap): string {
  const args = command.arguments.map(a => fprimeSeqArgDefault(a, enumMap));
  return [command.stem, args.join(', ')].filter(Boolean).join(' ');
}

function describe(arg: FswCommandArgument): string {
  if (arg.arg_type === 'enum') return arg.enum_name;
  if (arg.arg_type === 'integer' || arg.arg_type === 'unsigned') {
    return `${arg.arg_type === 'unsigned' ? 'U' : 'I'}${arg.bit_length ?? ''}`;
  }
  if (arg.arg_type === 'float') return `F${arg.bit_length ?? ''}`;
  return arg.arg_type;
}

export function fprimeSeqCompletion(context: PhoenixContext) {
  return (completion: CompletionContext): CompletionResult | null => {
    const dictionary = context.commandDictionary;
    const tree = syntaxTree(completion.state);
    const line = completion.state.doc.lineAt(completion.pos);
    const before = line.text.slice(0, completion.pos - line.from);
    const word = completion.matchBefore(/[\w.$]*/);
    if (!word || (word.from === word.to && !completion.explicit)) {
      return null;
    }

    // Line start: offer a time tag.
    if (/^\s*[RA]?[\w:-]*$/.test(before) && !/^\s*[RA]\s*\d/.test(before)) {
      return {
        from: word.from,
        options: [
          { apply: 'R00:00:00 ', detail: 'relative time tag', label: 'R00:00:00', type: 'keyword' },
          {
            apply: 'A2026-001T00:00:00 ',
            detail: 'absolute time tag (UTC, day of year)',
            label: 'A2026-001T00:00:00',
            type: 'keyword',
          },
        ],
      };
    }

    if (!dictionary) return null;

    // Right after a time tag: commands.
    if (/^\s*[RA]\s*[\d:T.-]+\s+[\w.$]*$/.test(before)) {
      return {
        from: word.from,
        options: dictionary.fswCommands.map(
          (command): Completion => ({
            apply: commandSnippet(command, dictionary.enumMap),
            detail: command.arguments.map(a => `${a.name}: ${describe(a)}`).join(', '),
            info: command.description,
            label: command.stem,
            type: 'function',
          }),
        ),
        validFor: /^[\w.$]*$/,
      };
    }

    // Argument position: enum constants for that argument.
    const node: SyntaxNode | null = tree.resolveInner(completion.pos, -1);
    const command = ancestor(node, 'Command');
    const stem = command?.getChild('Stem');
    const definition = stem && dictionary.fswCommandMap[completion.state.sliceDoc(stem.from, stem.to)];
    if (!command || !definition) return null;
    const index = (command.getChild('Args')?.getChildren('Arg') ?? []).filter(a => a.to < word.from).length;
    const arg = definition.arguments[index];
    if (arg?.arg_type === 'enum') {
      return {
        from: word.from,
        options: (dictionary.enumMap[arg.enum_name]?.values ?? []).map(v => ({
          detail: `${arg.enum_name} = ${v.numeric}`,
          label: v.symbol,
          type: 'enum',
        })),
      };
    }
    return null;
  };
}

function ancestor(node: SyntaxNode | null, name: string): SyntaxNode | null {
  for (let n = node; n; n = n.parent) {
    if (n.name === name) return n;
  }
  return null;
}

function fprimeSeqHover(context: PhoenixContext, resources: PhoenixResources) {
  return resources.hoverTooltip((view, pos) => {
    const dictionary = context.commandDictionary;
    const node = syntaxTree(view.state).resolveInner(pos, 1);
    const command = ancestor(node, 'Command');
    const stem = command?.getChild('Stem');
    const definition = stem && dictionary?.fswCommandMap[view.state.sliceDoc(stem.from, stem.to)];
    if (!command || !definition) return null;
    const args = command.getChild('Args')?.getChildren('Arg') ?? [];
    const index = args.findIndex(a => a.from <= pos && pos <= a.to);
    if (index >= 0 && definition.arguments[index]) {
      const arg = definition.arguments[index];
      return resources.createTooltip(
        [`${arg.name}: ${describe(arg)}`, arg.description ?? ''],
        args[index].from,
        args[index].to,
      );
    }
    return resources.createTooltip(
      [definition.stem, definition.description, ...definition.arguments.map(a => `${a.name}: ${describe(a)}`)],
      stem.from,
      stem.to,
    );
  });
}

/** Feeds the SeqDev command panel. `.seq` steps are a flat `<time> <stem> <args>` list. */
export class FprimeSeqCommandInfoMapper implements CommandInfoMapper {
  formatArgumentArray(values: string[]): string {
    return ' ' + values.join(', ');
  }

  getArgumentAppendPosition(node: SyntaxNode | null): number | undefined {
    if (node?.name === 'Command') {
      return node.getChild('Args')?.to ?? node.getChild('Stem')?.to;
    }
    if (node?.name === 'Array' || node?.name === 'Struct') {
      return node.to - 1;
    }
    return undefined;
  }

  getArgumentNodeContainer(commandNode: SyntaxNode | null): SyntaxNode | null {
    return commandNode?.getChild('Args') ?? null;
  }

  getArgumentsFromContainer(containerNode: SyntaxNode): SyntaxNode[] {
    if (containerNode.name === 'Struct') {
      return containerNode.getChildren('Member').map(m => m.getChild('Arg')!.firstChild!);
    }
    return containerNode.getChildren('Arg').map(a => a.firstChild!);
  }

  getArgumentInfo(
    commandDef: FswCommand | null,
    seqEditorView: EditorView,
    args: SyntaxNode | null,
    argumentDefs: FswCommandArgument[] | undefined,
    parentArgDef: FswCommandArgumentRepeat | undefined,
    phoenixContext: PhoenixContext,
  ): ArgTextDef[] {
    const out: ArgTextDef[] = [];
    const nodes = args ? this.getArgumentsFromContainer(args) : [];
    nodes.forEach((node, i) => {
      const length = argumentDefs?.length ?? 0;
      const argDef = argumentDefs?.[parentArgDef && length ? i % length : i];
      out.push({
        argDef,
        children:
          argDef && isFswCommandArgumentRepeat(argDef) && (node.name === 'Array' || node.name === 'Struct')
            ? this.getArgumentInfo(commandDef, seqEditorView, node, argDef.repeat?.arguments, argDef, phoenixContext)
            : undefined,
        node,
        parentArgDef,
        text: seqEditorView.state.sliceDoc(node.from, node.to),
      });
    });
    if (argumentDefs && !parentArgDef) {
      out.push(...argumentDefs.slice(out.length).map(argDef => ({ argDef })));
    }
    return out;
  }

  getCommandDef(
    commandDictionary: CommandDictionary | null,
    _librarySequences: LibrarySequenceSignature[],
    stemName: string,
  ): FswCommand | null {
    return commandDictionary?.fswCommandMap[stemName] ?? null;
  }

  getContainingCommand(node: SyntaxNode | null): SyntaxNode | null {
    return ancestor(node, 'Command');
  }

  /** Enum constants are bare identifiers. */
  formatEnumValue(symbol: string): string {
    return symbol;
  }

  getDefaultValueForArgumentDef(argDef: FswCommandArgument, enumMap: EnumMap): string {
    return fprimeSeqArgDefault(argDef, enumMap);
  }

  getNameNode(stepNode: SyntaxNode | null): SyntaxNode | null {
    return stepNode?.getChild('Stem') ?? null;
  }

  getTimeTagInfo(seqEditorView: EditorView, node: SyntaxNode | null): TimeTagInfo {
    const timeTag = node?.getChild('TimeTag');
    return timeTag && { node: timeTag, text: seqEditorView.state.sliceDoc(timeTag.from, timeTag.to) };
  }

  /** `.seq` has no variables. */
  getVariables(): string[] {
    return [];
  }

  getVariablesInScope(_view: EditorView, _tree: Tree | null): string[] {
    return [];
  }

  isArgumentNodeOfVariableType(): boolean {
    return false;
  }

  isByteArrayArg(): boolean {
    return false;
  }

  nodeTypeEnumCompatible(node: SyntaxNode | null): boolean {
    return node?.name === 'Enum';
  }

  nodeTypeHasArguments(node: SyntaxNode | null): boolean {
    return node?.name === 'Command';
  }

  nodeTypeNumberCompatible(node: SyntaxNode | null): boolean {
    return node?.name === 'Number';
  }
}

export function getFprimeSeqExtensions(context: PhoenixContext, resources: PhoenixResources) {
  const language = getFprimeSeqLRLanguage(resources);
  return [
    new LanguageSupport(language, [language.data.of({ autocomplete: fprimeSeqCompletion(context) })]),
    resources.linter(view =>
      validateFprimeSeq(view.state.doc.toString(), syntaxTree(view.state), context.commandDictionary),
    ),
    fprimeSeqHover(context, resources),
  ];
}

/** Standard F Prime command sequence, compiled to `.bin` by `fprime-seqgen`. */
export const fprimeSeqLanguage: InputLanguage = {
  commandInfoMapper: new FprimeSeqCommandInfoMapper(),
  fileExtension: '.seq',
  getEditorExtension: getFprimeSeqExtensions,
  name: 'F Prime Sequence',
};
