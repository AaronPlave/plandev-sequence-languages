import { rust } from '@codemirror/lang-rust';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { parser } from '@lezer/rust';
import { describe, expect, it } from 'vitest';
import type { PhoenixContext } from '../../interfaces/phoenix.js';
import { FprimeRustCommandInfoMapper, getFprimeRustProfile, rustCallStem, rustCommandCalls } from './language.js';

const context = {
  channelDictionary: { telemetryMap: { 'Ref.typeDemo.ScalarU32Ch': {} } },
  commandDictionary: { fswCommandMap: { 'CdhCore.cmdDisp.CMD_NO_OP_STRING': {} }, fswCommands: [] },
  librarySequences: [],
  parameterDictionaries: [{ paramMap: { 'Ref.recvBuffComp.parameter1': {} } }],
} as unknown as PhoenixContext;

function rustState(doc: string) {
  const state = EditorState.create({ doc, extensions: rust() });
  ensureSyntaxTree(state, doc.length, 1000);
  return state;
}

describe('F Prime Rust', () => {
  it('reads the profile from the source, not a separate setting', () => {
    expect(getFprimeRustProfile('#[fprime_main(restrict)]\npub fn main() {}')).toBe('restrict');
    expect(getFprimeRustProfile('#[fprime_main( recommended )] pub fn main() {}')).toBe('recommended');
    expect(getFprimeRustProfile('#[fprime_main]\npub fn main() {}')).toBe('');
    expect(getFprimeRustProfile('pub fn helper() {}')).toBeNull();
  });

  it('recognizes plain command calls only', () => {
    expect(rustCallStem('CdhCore.cmdDisp.CMD_NO_OP')).toBe('CdhCore.cmdDisp.CMD_NO_OP');
    expect(rustCallStem('Cmd::CdhCore.cmdDisp.CMD_NO_OP')).toBe('CdhCore.cmdDisp.CMD_NO_OP');
    expect(rustCallStem('Tlm::CdhCore.events.EventsDropped')).toBeNull();
    expect(rustCallStem('set_fail_mode')).toBeNull();
  });

  it('finds the command and its arguments from inside a call', () => {
    const src = 'fn main() { if x > 1 { MathProject.mathSender.DO_MATH(1.5, ADD, f * 2.0); } }';
    const tree = parser.parse(src);
    const mapper = new FprimeRustCommandInfoMapper();
    const inner = tree.resolveInner(src.indexOf('ADD'), 1);
    const call = mapper.getContainingCommand(inner)!;
    expect(src.slice(mapper.getNameNode(call)!.from, mapper.getNameNode(call)!.to)).toBe(
      'MathProject.mathSender.DO_MATH',
    );
    const args = mapper.getArgumentsFromContainer(mapper.getArgumentNodeContainer(call)!);
    expect(args.map(a => src.slice(a.from, a.to))).toEqual(['1.5', 'ADD', 'f * 2.0']);
    expect(mapper.nodeTypeNumberCompatible(args[0])).toBe(true);
    expect(mapper.nodeTypeEnumCompatible(args[1])).toBe(true);
    // A computed argument is neither: the panel leaves it to the source editor.
    expect(mapper.nodeTypeNumberCompatible(args[2]) || mapper.nodeTypeEnumCompatible(args[2])).toBe(false);
  });

  it('inspects dictionary commands, telemetry and parameters at the cursor, and nothing else', () => {
    const src =
      'fn main() { CdhCore.cmdDisp.CMD_NO_OP_STRING(helper.name(1)); let (v, _) = Tlm::Ref.typeDemo.ScalarU32Ch(); ' +
      'if Prm::Ref.recvBuffComp.parameter1() > v { x.method(); } }';
    const state = rustState(src);
    const view = { state } as EditorView;
    const mapper = new FprimeRustCommandInfoMapper();
    const at = (text: string) => {
      const item = mapper.getDictionaryItemAt(
        ensureSyntaxTree(state, src.length)!.resolveInner(src.indexOf(text) + 1, 1),
        view,
        context,
      );
      return item && [item.kind, item.name];
    };
    // Inside a helper call nested in a command's arguments: the command.
    expect(at('helper')).toEqual(['command', 'CdhCore.cmdDisp.CMD_NO_OP_STRING']);
    expect(at('typeDemo')).toEqual(['telemetry', 'Ref.typeDemo.ScalarU32Ch']);
    expect(at('parameter1')).toEqual(['parameter', 'Ref.recvBuffComp.parameter1']);
    expect(at('method')).toBeNull();
    expect(at('let')).toBeNull();
  });

  it('lists dictionary-style calls for mission rules', () => {
    const state = rustState('fn main() { A.b.C(1); Tlm::A.b.T(); helper(); x.y(); }');
    expect(rustCommandCalls(state).map(c => [c.kind, c.name])).toEqual([
      ['command', 'A.b.C'],
      ['telemetry', 'A.b.T'],
      ['command', 'x.y'],
    ]);
  });
});
