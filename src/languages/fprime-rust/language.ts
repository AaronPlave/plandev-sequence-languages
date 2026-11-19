import { rust } from '@codemirror/lang-rust';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { forceLinting, type Diagnostic } from '@codemirror/lint';
import {
  findReferences,
  findReferencesKeymap,
  formatDocument,
  formatKeymap,
  hoverTooltips,
  jumpToDefinition,
  jumpToDefinitionKeymap,
  LSPPlugin,
  renameKeymap,
  renameSymbol,
  serverCompletion,
  serverDiagnostics,
  signatureHelp,
  type LSPClientExtension,
} from '@codemirror/lsp-client';
import { EditorState, MapMode, StateEffect, StateField, type Extension } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import type {
  CommandDictionary,
  EnumMap,
  FswCommand,
  FswCommandArgument,
  FswCommandArgumentRepeat,
} from '@nasa-jpl/plandev-ampcs';
import { EditorView, highlightActiveLine, keymap, lineNumbers, showPanel, ViewPlugin } from '@codemirror/view';
import type {
  ArgTextDef,
  CommandInfoMapper,
  DictionaryItemAt,
  OutlineEntry,
  TimeTagInfo,
} from '../../interfaces/command-info-mapper.js';
import type { InputLanguage } from '../../interfaces/language.js';
import type {
  CodeHelpStatus,
  LibrarySequenceSignature,
  PhoenixContext,
  PhoenixResources,
} from '../../interfaces/phoenix.js';
import { fprimeSeqArgDefault } from '../fprime-seq/fprime-seq-validate.js';
import { getLspConnection, type ConnectionStatus, type LspConnection } from './lsp-connection.js';

export type FprimeRustLanguageOptions = {
  /**
   * WebSocket URL of a rust-analyzer bridge. The editor connects to
   * `<lspUrl>?workspaceId=<id>&path=<file path>`; the bridge finds the file's Cargo project.
   * Without it the editor still highlights Rust and completes dictionary commands.
   */
  lspUrl?: string;
  /**
   * Mission editor rules, run as one more CodeMirror lint source beside the language server's
   * diagnostics (both are kept; neither replaces the other). Runs without the language server too.
   * Set `source` on the diagnostics to say where they come from. See `rustCommandCalls`.
   */
  lint?: (view: EditorView, context: PhoenixContext) => Diagnostic[];
};

/** `A.b.C` → command, `Tlm::A.b.C` → telemetry read, `Prm::A.b.c` → parameter read. */
export function rustDictionaryCall(calleeText: string): { kind: DictionaryItemAt['kind']; name: string } | null {
  const match = /^(?:(Cmd|Tlm|Prm)::)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)$/.exec(calleeText.replace(/\s+/g, ''));
  if (!match) return null;
  return { kind: match[1] === 'Tlm' ? 'telemetry' : match[1] === 'Prm' ? 'parameter' : 'command', name: match[2] };
}

/**
 * Every dictionary-style call in a Rust document, in order: `A.b.C(..)` commands and `Tlm::`/`Prm::`
 * reads. A building block for mission lint rules; whether a name is in the dictionary is not checked.
 */
export function rustCommandCalls(
  state: EditorState,
): { from: number; kind: DictionaryItemAt['kind']; name: string; node: SyntaxNode; to: number }[] {
  const calls: { from: number; kind: DictionaryItemAt['kind']; name: string; node: SyntaxNode; to: number }[] = [];
  syntaxTree(state).iterate({
    enter: ref => {
      const callee = ref.node.firstChild;
      if (ref.name !== 'CallExpression' || callee?.name !== 'FieldExpression') return;
      const call = rustDictionaryCall(state.sliceDoc(callee.from, callee.to));
      if (call) calls.push({ ...call, from: ref.from, node: ref.node, to: ref.to });
    },
  });
  return calls;
}

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

  /** A command call statement, the same text dictionary completion inserts. */
  formatCommandCall(command: FswCommand, enumMap: EnumMap): string {
    return `${command.stem}(${command.arguments.map(a => fprimeRustArgDefault(a, enumMap)).join(', ')});`;
  }

  /**
   * Only inside a block (a function body, loop or branch): after the statement holding the cursor,
   * or at the cursor between statements. Elsewhere (imports, signatures, attributes) is unsafe.
   */
  getCommandInsertPosition(state: EditorState, pos: number): number | null {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
      if (n.name === 'Block') return pos;
      if (n.parent?.name === 'Block') return n.to;
    }
    return null;
  }

  /**
   * Functions, loops and branches as written, dictionary command calls and telemetry/parameter
   * reads, and `rsleep`/`asleep` waits. Calls through helpers are listed where the helper is
   * called, not expanded: this is the source's shape, not an execution trace.
   */
  getOutline(state: EditorState, context: PhoenixContext): OutlineEntry[] {
    const out: OutlineEntry[] = [];
    const text = (n: SyntaxNode) => state.sliceDoc(n.from, n.to);
    const loops: Record<string, string> = { ForExpression: 'for', LoopExpression: 'loop', WhileExpression: 'while' };
    let depth = 0;
    syntaxTree(state).iterate({
      enter: ref => {
        const n = ref.node;
        let entry: Omit<OutlineEntry, 'depth' | 'from'> | null = null;
        if (n.name === 'FunctionItem') {
          entry = {
            kind: 'function',
            label: `fn ${n.getChild('BoundIdentifier') ? text(n.getChild('BoundIdentifier')!) : '?'}`,
          };
        } else if (loops[n.name]) {
          entry = {
            kind: 'loop',
            label: text(n).split('{')[0].trim().replace(/\s+/g, ' ').slice(0, 60) || loops[n.name],
          };
        } else if (n.name === 'IfExpression') {
          entry = { kind: 'branch', label: text(n).split('{')[0].trim().replace(/\s+/g, ' ').slice(0, 60) };
        } else if (n.name === 'CallExpression' && n.firstChild) {
          const callee = text(n.firstChild).replace(/\s+/g, '');
          const call = n.firstChild.name === 'FieldExpression' ? rustDictionaryCall(callee) : null;
          const known =
            call &&
            (call.kind === 'command'
              ? context.commandDictionary?.fswCommandMap[call.name]
              : call.kind === 'telemetry'
                ? context.channelDictionary?.telemetryMap[call.name]
                : context.parameterDictionaries.some(d => d.paramMap[call.name]));
          if (call && known) {
            entry = { kind: call.kind === 'command' ? 'command' : 'read', label: call.name };
          } else if (/^(rsleep|asleep)$/.test(callee)) {
            entry = { kind: 'wait', label: text(n).replace(/\s+/g, ' ') };
          }
        }
        if (entry) {
          out.push({ ...entry, depth, from: n.from });
          if (entry.kind === 'command' || entry.kind === 'read' || entry.kind === 'wait') return false;
          depth++;
        }
        return undefined;
      },
      leave: ref => {
        if (ref.name === 'FunctionItem' || ref.name === 'IfExpression' || loops[ref.name]) depth--;
      },
    });
    return out;
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

  /** The nearest enclosing call the parcel's dictionaries define; helpers and `x.method()` are skipped. */
  getDictionaryItemAt(node: SyntaxNode | null, view: EditorView, context: PhoenixContext): DictionaryItemAt | null {
    for (let n = node; n; n = n.parent) {
      if (!isCommandCall(n)) continue;
      const call = rustDictionaryCall(view.state.sliceDoc(n.firstChild!.from, n.firstChild!.to));
      const known =
        call?.kind === 'command'
          ? context.commandDictionary?.fswCommandMap[call.name]
          : call?.kind === 'telemetry'
            ? context.channelDictionary?.telemetryMap[call.name]
            : call?.kind === 'parameter' && context.parameterDictionaries.some(d => d.paramMap[call.name]);
      if (call && known) return { ...call, node: n };
    }
    return null;
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

/**
 * Dictionary command completion: always without a language server, and until rust-analyzer is
 * ready with one (then it completes the same commands from the generated API, so this steps aside).
 */
function dictionaryCompletion(context: PhoenixContext) {
  return (completion: CompletionContext): CompletionResult | null => {
    const word = completion.matchBefore(/[\w.]*/);
    const dictionary = context.commandDictionary;
    if (!dictionary || !word || (word.from === word.to && !completion.explicit)) return null;
    if (completion.view && isCodeHelpReady(completion.view)) return null;
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

/** The Cargo project a file belongs to, by Cargo's layout (`<project>/src/...`, `<project>/build.rs`). */
function cargoProjectOf(path: string): string {
  // ponytail: layout heuristic; the bridge finds the real Cargo.toml, a miss only costs a second session.
  return /^(.*?)\/(?:src|tests|examples|benches)\//.exec(path)?.[1] ?? path.replace(/\/?[^/]*$/, '');
}

/** The language-server connection an editor uses, for readiness checks by commands and completion. */
const editorConnections = new WeakMap<EditorView, LspConnection>();

function isCodeHelpReady(view: EditorView): boolean {
  return editorConnections.get(view)?.status.state === 'ready';
}

function codeHelpStatus(status: ConnectionStatus): CodeHelpStatus {
  switch (status.state) {
    case 'ready':
      return { state: 'ready' };
    case 'connecting':
    case 'connected':
    case 'retrying':
      return { state: 'preparing' };
    default:
      return { message: status.message, state: 'unavailable' };
  }
}

/**
 * rust-analyzer diagnostics as one lint source among others (mission rules), instead of
 * lsp-client's own handler, which replaces every diagnostic in the editor on each publish.
 * Kept mapped through edits until the server publishes again.
 */
const setServerDiagnostics = StateEffect.define<Diagnostic[]>();
const serverDiagnosticsField = StateField.define<Diagnostic[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setServerDiagnostics)) return effect.value;
    if (!tr.docChanged || !value.length) return value;
    if (tr.isUserEvent('file.open')) return []; // another file loaded into this editor
    // Like CodeMirror's own diagnostics: one whose text was deleted goes, until the server re-checks.
    return value.flatMap(d => {
      const from = tr.changes.mapPos(d.from, -1, MapMode.TrackDel);
      const to = tr.changes.mapPos(d.to, 1, MapMode.TrackDel);
      return from === null || to === null ? [] : [{ ...d, from, to }];
    });
  },
});

const severities = ['error', 'error', 'warning', 'info', 'hint'] as const;

function lintedServerDiagnostics(): LSPClientExtension {
  return {
    ...serverDiagnostics(), // client capability, and its sync of edits so the server re-checks them
    notificationHandlers: {
      'textDocument/publishDiagnostics': (client, params) => {
        const file = client.workspace.getFile(params.uri);
        if (!file || (params.version != null && params.version !== file.version)) return false;
        const view = file.getView();
        const plugin = view && LSPPlugin.get(view);
        if (!view || !plugin) return false;
        const at = (position: { character: number; line: number }) =>
          plugin.unsyncedChanges.mapPos(plugin.fromPosition(position, plugin.syncedDoc));
        const diagnostics: Diagnostic[] = params.diagnostics.map(
          (d: {
            message: string;
            range: { end: { character: number; line: number }; start: { character: number; line: number } };
            severity?: number;
            source?: string;
          }) => ({
            from: at(d.range.start),
            message: d.message,
            severity: severities[d.severity ?? 1] ?? 'error',
            source: d.source ?? 'language server',
            to: at(d.range.end),
          }),
        );
        view.dispatch({ effects: setServerDiagnostics.of(diagnostics) });
        forceLinting(view);
        return true;
      },
    },
  };
}

const clientExtensions = [
  serverCompletion(),
  hoverTooltips(),
  // In an array: lsp-client keeps only arrays and `{extension}` objects, and a bare keymap is
  // neither with @codemirror/state < 6.6 (SeqDev's), so F12 & co. were silently dropped.
  [keymap.of([...formatKeymap, ...renameKeymap, ...jumpToDefinitionKeymap, ...findReferencesKeymap])],
  signatureHelp(),
  lintedServerDiagnostics(),
];

/**
 * Read-only view of a source rust-analyzer points at outside the workspace: the API generated from
 * the dictionary, the F Prime crates, the standard library. Shown in a panel of the editor, whose
 * own EditorView is what Go to Definition moves the cursor in.
 */
const showSource = StateEffect.define<{ text: string; title: string } | null>();
const sourceViews = new WeakMap<EditorView, EditorView>();
const sourcePanel = StateField.define<{ text: string; title: string } | null>({
  create: () => null,
  provide: field =>
    showPanel.from(field, source =>
      source
        ? view => {
            const dom = document.createElement('div');
            dom.className = 'cm-seqdev-source';
            dom.setAttribute('role', 'region');
            dom.setAttribute('aria-label', source.title);
            const header = dom.appendChild(document.createElement('div'));
            header.className = 'cm-seqdev-source-header';
            header.appendChild(document.createElement('span')).textContent = source.title;
            const close = header.appendChild(document.createElement('button'));
            close.type = 'button';
            close.textContent = 'Close';
            close.onclick = () => view.dispatch({ effects: showSource.of(null) });
            const inner = new EditorView({
              doc: source.text,
              extensions: [
                rust(),
                syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
                lineNumbers(),
                highlightActiveLine(),
                EditorState.readOnly.of(true),
                EditorView.theme({ '&': { height: '30vh' }, '.cm-scroller': { overflow: 'auto' } }),
              ],
              parent: dom,
            });
            sourceViews.set(view, inner);
            return {
              destroy: () => {
                inner.destroy();
                if (sourceViews.get(view) === inner) sourceViews.delete(view);
              },
              dom,
              top: false,
            };
          }
        : null,
    ),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(showSource)) return effect.value;
    return tr.isUserEvent('file.open') ? null : value;
  },
});

const sourcePanelTheme = EditorView.baseTheme({
  '.cm-seqdev-source': { borderTop: '1px solid #ddd' },
  '.cm-seqdev-source-header': {
    alignItems: 'center',
    background: '#f5f5f5',
    display: 'flex',
    fontFamily: 'sans-serif',
    fontSize: '12px',
    justifyContent: 'space-between',
    padding: '2px 8px',
  },
});

function sourceTitle(uri: string): string {
  const path = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  if (path.includes('/ra-target/')) return `Generated from the dictionary (read only): ${path.split('/').pop()}`;
  const library = /\/(?:vendor|rustlib\/src\/rust)\/(.*)$/.exec(path)?.[1] ?? path.split('/').pop();
  return `Library source (read only): ${library}`;
}

/**
 * rust-analyzer for this file, through the session shared by its Cargo project's open editors.
 * The session lives as long as some editor uses it (plus a grace period), see `LspConnection`.
 */
function lspExtension(lspUrl: string, context: PhoenixContext, resources: PhoenixResources): Extension {
  const file = context.sequenceFile;
  if (!file) return [];
  const path = file.path.replace(/^\/+/, '');
  const connection = getLspConnection(
    `${lspUrl}|${file.workspaceId}|${cargoProjectOf(path)}`,
    `${lspUrl}?workspaceId=${file.workspaceId}&path=${encodeURIComponent(path)}`,
    { extensions: clientExtensions },
  );
  const workspacePrefix = `file:///seqdev/${file.workspaceId}/`;
  const usage = ViewPlugin.define(view => {
    let alive = true;
    let shown = '';
    const onStatus = (status: ConnectionStatus) => {
      if (!alive) return;
      if (resources.setCodeHelpStatus) {
        const effect = resources.setCodeHelpStatus.of(codeHelpStatus(status));
        // Statuses also arrive while the editor is updating (acquire); never dispatch inside an update.
        queueMicrotask(() => alive && view.dispatch({ effects: effect }));
      } else if ('message' in status && status.state !== 'retrying' && status.message !== shown) {
        // An editor without a status indicator: show what needs the user's attention, once.
        shown = status.message;
        LSPPlugin.get(view)?.reportError('Rust language server', status.message);
      }
    };
    const displayFile = async (uri: string): Promise<EditorView | null> => {
      try {
        if (uri.startsWith(workspacePrefix)) {
          return (await context.openWorkspaceFile?.(decodeURIComponent(uri.slice(workspacePrefix.length)))) ?? null;
        }
        const { text } = await connection.client.request<{ uri: string }, { text: string }>('seqdev/readFile', { uri });
        view.dispatch({ effects: showSource.of({ text, title: sourceTitle(uri) }) });
        return sourceViews.get(view) ?? null;
      } catch (e) {
        LSPPlugin.get(view)?.reportError('Cannot show the definition', e);
        return null;
      }
    };
    editorConnections.set(view, connection);
    connection.displayFile = displayFile;
    connection.acquire(onStatus);
    onStatus(connection.status);
    return {
      destroy: () => {
        alive = false;
        if (connection.displayFile === displayFile) connection.displayFile = null;
        if (editorConnections.get(view) === connection) editorConnections.delete(view);
        connection.release(onStatus);
      },
      update: update => update.docChanged && connection.poke(),
    };
  });
  return [
    connection.client.plugin(`${workspacePrefix}${path}`, 'rust'),
    usage,
    serverDiagnosticsField,
    resources.linter(view => view.state.field(serverDiagnosticsField, false) ?? [], {
      // Re-run every lint source when the server publishes (forceLinting alone only hurries a pending run).
      needsRefresh: update => update.transactions.some(tr => tr.effects.some(e => e.is(setServerDiagnostics))),
    }),
    sourcePanel,
    sourcePanelTheme,
  ];
}

export function fprimeRustLanguage(options: FprimeRustLanguageOptions = {}): InputLanguage {
  const { lint, lspUrl } = options;
  const whenReady = (view: EditorView) => isCodeHelpReady(view);
  return {
    commandInfoMapper: new FprimeRustCommandInfoMapper(),
    fileExtension: '.rs',
    getEditorExtension: (context: PhoenixContext, resources: PhoenixResources) => {
      const support = rust();
      return [
        support,
        support.language.data.of({ autocomplete: dictionaryCompletion(context) }),
        lint ? resources.linter(view => lint(view, context)) : [],
        lspUrl ? lspExtension(lspUrl, context, resources) : [],
      ];
    },
    name: 'F Prime Rust',
    ...(lspUrl
      ? {
          canFormat: view =>
            whenReady(view) && !!LSPPlugin.get(view)?.client.serverCapabilities?.documentFormattingProvider,
          editorCommands: [
            { isEnabled: whenReady, label: 'Go to definition', run: jumpToDefinition, shortcut: 'F12' },
            { isEnabled: whenReady, label: 'Find references', run: findReferences, shortcut: 'Shift+F12' },
            { isEnabled: whenReady, label: 'Rename symbol', run: renameSymbol, shortcut: 'F2' },
          ],
          format: view => {
            formatDocument(view);
          },
        }
      : {}),
  };
}

/** Profile named by `#[fprime_main(<profile>)]`, `''` for an unchecked `#[fprime_main]`. */
export function getFprimeRustProfile(source: string): string | null {
  const match = /#\[\s*fprime_main\s*(?:\(\s*(\w+)\s*\))?\s*\]/.exec(source);
  return match ? (match[1] ?? '') : null;
}
