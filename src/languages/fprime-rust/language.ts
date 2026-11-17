import { rust } from '@codemirror/lang-rust';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { LSPClient, languageServerExtensions, type Transport } from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
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
import type { LibrarySequenceSignature, PhoenixContext } from '../../interfaces/phoenix.js';
import { fprimeSeqArgDefault } from '../fprime-seq/fprime-seq-validate.js';

export type FprimeRustLanguageOptions = {
  /**
   * WebSocket URL of a rust-analyzer bridge. The editor connects to
   * `<lspUrl>?workspaceId=<id>&path=<file path>`; the bridge finds the file's Cargo project.
   * Without it the editor still highlights Rust and completes dictionary commands.
   */
  lspUrl?: string;
};

/** `Cmd::A.b.C`, `A.b.C` → `A.b.C`; telemetry/parameter reads are not commands. */
export function rustCallStem(calleeText: string): string | null {
  const text = calleeText.replace(/\s+/g, '');
  if (/^(Tlm|Prm)::/.test(text)) return null;
  const stem = text.replace(/^Cmd::/, '');
  return /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(stem) ? stem : null;
}

/** A Rust literal for an argument default. Struct arguments fall back to source editing. */
export function fprimeRustArgDefault(def: FswCommandArgument, enumMap: EnumMap): string {
  if (def.arg_type === 'repeat') {
    const members = def.repeat?.arguments ?? [];
    if (members.length === 1 && (def.repeat?.min ?? 0) > 1) {
      return `[${Array.from({ length: def.repeat?.min ?? 0 }, () => fprimeRustArgDefault(members[0], enumMap)).join(', ')}]`;
    }
    return `todo!(/* ${def.name} */)`;
  }
  return fprimeSeqArgDefault(def, enumMap);
}

function ancestor(node: SyntaxNode | null, predicate: (n: SyntaxNode) => boolean): SyntaxNode | null {
  for (let n = node; n; n = n.parent) {
    if (predicate(n)) return n;
  }
  return null;
}

const isCommandCall = (n: SyntaxNode) => n.name === 'CallExpression' && n.firstChild?.name === 'FieldExpression';

/**
 * Opportunistic command panel support: a call like `CdhCore.cmdDisp.CMD_NO_OP_STRING("x")` is
 * shown and edited like any other command. Anything else (loops, helpers, computed arguments)
 * is left to the source editor; nothing here claims to understand Rust control flow.
 */
export class FprimeRustCommandInfoMapper implements CommandInfoMapper {
  formatArgumentArray(values: string[], commandNode: SyntaxNode | null): string {
    const hasArgs =
      (commandNode?.getChild('ArgList') && this.getArgumentsFromContainer(commandNode.getChild('ArgList')!).length) ??
      0;
    return (hasArgs ? ', ' : '') + values.join(', ');
  }

  getArgumentAppendPosition(node: SyntaxNode | null): number | undefined {
    const container = node?.name === 'CallExpression' ? node.getChild('ArgList') : node;
    return container ? container.to - 1 : undefined;
  }

  getArgumentNodeContainer(commandNode: SyntaxNode | null): SyntaxNode | null {
    return commandNode?.getChild('ArgList') ?? null;
  }

  getArgumentsFromContainer(containerNode: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let child = containerNode.firstChild; child; child = child.nextSibling) {
      if (!['(', ')', ',', '[', ']', 'LineComment', 'BlockComment'].includes(child.name)) out.push(child);
    }
    return out;
  }

  getArgumentInfo(
    _commandDef: FswCommand | null,
    view: EditorView,
    args: SyntaxNode | null,
    argumentDefs: FswCommandArgument[] | undefined,
    parentArgDef: FswCommandArgumentRepeat | undefined,
  ): ArgTextDef[] {
    const out: ArgTextDef[] = (args ? this.getArgumentsFromContainer(args) : []).map((node, i) => ({
      argDef: argumentDefs?.[i],
      node,
      parentArgDef,
      text: view.state.sliceDoc(node.from, node.to),
    }));
    if (argumentDefs && !parentArgDef) out.push(...argumentDefs.slice(out.length).map(argDef => ({ argDef })));
    return out;
  }

  getCommandDef(
    commandDictionary: CommandDictionary | null,
    _l: LibrarySequenceSignature[],
    stemName: string,
  ): FswCommand | null {
    const stem = rustCallStem(stemName);
    return (stem && commandDictionary?.fswCommandMap[stem]) || null;
  }

  getContainingCommand(node: SyntaxNode | null): SyntaxNode | null {
    return ancestor(node, isCommandCall);
  }

  /** Enum constants are bare identifiers. */
  formatEnumValue(symbol: string): string {
    return symbol;
  }

  getDefaultValueForArgumentDef(argDef: FswCommandArgument, enumMap: EnumMap): string {
    return fprimeRustArgDefault(argDef, enumMap);
  }

  getNameNode(stepNode: SyntaxNode | null): SyntaxNode | null {
    return stepNode?.name === 'CallExpression' ? stepNode.firstChild : null;
  }

  /** Rust sequences carry timing as `rsleep`/`asleep` calls, not per-command tags. */
  getTimeTagInfo(): TimeTagInfo {
    return null;
  }

  getVariables(): string[] {
    return [];
  }

  getVariablesInScope(_view: EditorView, _tree: Tree | null): string[] {
    return [];
  }

  /**
   * A bare identifier argument is usually an enum constant (`ADD`), which the macros resolve by
   * argument type; telling it from a `let` binding needs rust-analyzer, so treat it as a literal.
   */
  isArgumentNodeOfVariableType(): boolean {
    return false;
  }

  isByteArrayArg(): boolean {
    return false;
  }

  nodeTypeEnumCompatible(node: SyntaxNode | null): boolean {
    return node?.name === 'Identifier';
  }

  nodeTypeHasArguments(node: SyntaxNode | null): boolean {
    return !!node && isCommandCall(node);
  }

  nodeTypeNumberCompatible(node: SyntaxNode | null): boolean {
    return node?.name === 'Integer' || node?.name === 'Float';
  }
}

/** Dictionary command completion, used when no language server is configured. */
function dictionaryCompletion(context: PhoenixContext) {
  return (completion: CompletionContext): CompletionResult | null => {
    const word = completion.matchBefore(/[\w.]*/);
    const dictionary = context.commandDictionary;
    if (!dictionary || !word || (word.from === word.to && !completion.explicit)) return null;
    return {
      from: word.from,
      options: dictionary.fswCommands.map(command => ({
        apply: `${command.stem}(${command.arguments.map(a => fprimeRustArgDefault(a, dictionary.enumMap)).join(', ')});`,
        detail: command.arguments.map(a => a.name).join(', '),
        info: command.description,
        label: command.stem,
        type: 'function',
      })),
      validFor: /^[\w.]*$/,
    };
  };
}

/** Raw JSON messages over a WebSocket, as `@codemirror/lsp-client` expects. */
function webSocketTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const handlers: ((message: string) => void)[] = [];
    const socket = new WebSocket(url);
    socket.onmessage = event => handlers.forEach(h => h(event.data.toString()));
    socket.onerror = () => reject(new Error(`Could not connect to Rust language server at ${url}`));
    socket.onopen = () =>
      resolve({
        send: message => socket.send(message),
        subscribe: handler => handlers.push(handler),
        unsubscribe: handler => handlers.splice(handlers.indexOf(handler) >>> 0, 1),
      });
  });
}

/**
 * One LSP client per document, so each Rust file gets its own rust-analyzer session rooted
 * at its own Cargo project. Kept across editor reconfigurations (dictionary reloads etc.).
 */
const clients = new Map<string, LSPClient>();

function lspExtension(lspUrl: string, context: PhoenixContext): Extension {
  const file = context.sequenceFile;
  if (!file) return [];
  const uri = `file:///seqdev/${file.workspaceId}/${file.path.replace(/^\/+/, '')}`;
  let client = clients.get(uri);
  if (!client) {
    client = new LSPClient({ extensions: languageServerExtensions(), rootUri: 'file:///seqdev/' });
    const url = `${lspUrl}?workspaceId=${file.workspaceId}&path=${encodeURIComponent(file.path)}`;
    const connecting = client;
    webSocketTransport(url)
      .then(transport => connecting.connect(transport))
      .catch(e => console.error(e));
    clients.set(uri, client);
  }
  return client.plugin(uri, 'rust');
}

export function fprimeRustLanguage(options: FprimeRustLanguageOptions = {}): InputLanguage {
  return {
    commandInfoMapper: new FprimeRustCommandInfoMapper(),
    fileExtension: '.rs',
    getEditorExtension: (context: PhoenixContext) => {
      const support = rust();
      return [
        support,
        options.lspUrl
          ? lspExtension(options.lspUrl, context)
          : support.language.data.of({ autocomplete: dictionaryCompletion(context) }),
      ];
    },
    name: 'F Prime Rust',
  };
}

/** Profile named by `#[fprime_main(<profile>)]`, `''` for an unchecked `#[fprime_main]`. */
export function getFprimeRustProfile(source: string): string | null {
  const match = /#\[\s*fprime_main\s*(?:\(\s*(\w+)\s*\))?\s*\]/.exec(source);
  return match ? (match[1] ?? '') : null;
}
