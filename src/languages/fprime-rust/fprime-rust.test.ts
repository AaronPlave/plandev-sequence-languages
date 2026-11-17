import { parser } from '@lezer/rust';
import { describe, expect, it } from 'vitest';
import { FprimeRustCommandInfoMapper, getFprimeRustProfile, rustCallStem } from './language.js';

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
});
