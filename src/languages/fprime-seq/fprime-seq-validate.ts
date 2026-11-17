import type { SyntaxNode, Tree } from '@lezer/common';
import type { CommandDictionary, EnumMap, FswCommandArgument } from '@nasa-jpl/plandev-ampcs';

export type FprimeSeqDiagnostic = {
  from: number;
  message: string;
  severity: 'error' | 'warning';
  to: number;
};

/**
 * Checks an F Prime `.seq` against the command dictionary, as far as the dictionary allows:
 * known mnemonic, argument count, and each argument's type (integer width, enum membership,
 * array length, struct members). F Prime dictionaries carry no operational argument ranges,
 * so those cannot be checked here. `fprime-seqgen` stays the authority; this gives earlier,
 * located feedback, and catches extra arguments, which seqgen silently drops.
 */
export function validateFprimeSeq(
  text: string,
  tree: Tree,
  commandDictionary: CommandDictionary | null,
): FprimeSeqDiagnostic[] {
  const diagnostics: FprimeSeqDiagnostic[] = [];
  const slice = (node: SyntaxNode) => text.slice(node.from, node.to);
  const error = (node: { from: number; to: number }, message: string) =>
    diagnostics.push({ from: node.from, message, severity: 'error', to: Math.max(node.to, node.from + 1) });

  tree.iterate({
    enter: ref => {
      if (ref.type.isError) {
        error(ref, 'Syntax error: expected `<R|A time tag> <Component.instance.COMMAND> [args]`');
        return false;
      }
      return undefined;
    },
  });

  for (const command of tree.topNode.getChildren('Command')) {
    const timeTag = command.getChild('TimeTag');
    if (timeTag) {
      const message = validateTimeTag(slice(timeTag));
      if (message) {
        error(timeTag, message);
      }
    }

    const stem = command.getChild('Stem');
    if (!stem || !commandDictionary) {
      continue;
    }
    const definition = commandDictionary.fswCommandMap[slice(stem)];
    if (!definition) {
      error(stem, `Unknown command '${slice(stem)}'`);
      continue;
    }

    const args = command.getChild('Args')?.getChildren('Arg') ?? [];
    const expected = definition.arguments;
    if (args.length !== expected.length) {
      const target = args.length > expected.length ? args[expected.length] : stem;
      error(
        { from: target.from, to: args.length > expected.length ? args[args.length - 1].to : stem.to },
        `${definition.stem} takes ${expected.length} argument(s) (${expected.map(a => a.name).join(', ') || 'none'}), got ${args.length}`,
      );
    }
    args.slice(0, expected.length).forEach((arg, i) => {
      for (const d of validateArgument(arg, expected[i], commandDictionary.enumMap, text)) {
        diagnostics.push(d);
      }
    });
  }
  return diagnostics;
}

export function validateTimeTag(tag: string): string | null {
  const absolute = /^A\s*(\d{4})-(\d{3})T(\d{2}):(\d{2}):(\d{2})/.exec(tag);
  const relative = /^R\s*(\d{2}):(\d{2}):(\d{2})/.exec(tag);
  if (absolute) {
    const [, , day, h, m, s] = absolute.map(Number);
    if (day < 1 || day > 366) return `Day of year ${day} is out of range (001-366)`;
    if (h > 23 || m > 59 || s > 60) return 'Invalid time of day';
  } else if (relative) {
    const [, , m, s] = relative.map(Number);
    if (m > 59 || s > 59) return 'Invalid relative time: minutes and seconds must be < 60';
  }
  return null;
}

/** The value node inside an `Arg` wrapper. */
function valueOf(arg: SyntaxNode): SyntaxNode | null {
  return arg.firstChild;
}

export function validateArgument(
  arg: SyntaxNode,
  def: FswCommandArgument,
  enumMap: EnumMap,
  text: string,
): FprimeSeqDiagnostic[] {
  const value = valueOf(arg);
  if (!value) return [];
  const raw = text.slice(value.from, value.to);
  const out: FprimeSeqDiagnostic[] = [];
  const error = (message: string) => out.push({ from: value.from, message, severity: 'error', to: value.to });
  const expect = (kind: string, label: string) => {
    if (value.name !== kind) {
      error(`'${def.name}' expects ${label}`);
      return false;
    }
    return true;
  };

  switch (def.arg_type) {
    case 'integer':
    case 'unsigned': {
      if (!expect('Number', `an integer (${def.arg_type === 'unsigned' ? 'U' : 'I'}${def.bit_length ?? ''})`)) break;
      const parsed = parseInteger(raw);
      if (parsed === null) {
        error(`'${def.name}' expects an integer, got ${raw}`);
        break;
      }
      const bits = BigInt(def.bit_length ?? 64);
      const [zero, one, two] = [BigInt(0), BigInt(1), BigInt(2)];
      const [min, max] =
        def.arg_type === 'unsigned' ? [zero, two ** bits - one] : [-(two ** (bits - one)), two ** (bits - one) - one];
      if (parsed < min || parsed > max) {
        error(
          `'${def.name}' ${raw} is out of range for ${def.arg_type === 'unsigned' ? 'U' : 'I'}${bits} [${min}, ${max}]`,
        );
      }
      break;
    }
    case 'float':
    case 'numeric':
      expect('Number', 'a number');
      break;
    case 'boolean':
      expect('Boolean', 'true or false');
      break;
    case 'var_string':
    case 'fixed_string':
      expect('String', 'a quoted string');
      break;
    case 'enum': {
      if (!expect('Enum', `one of the ${def.enum_name} constants`)) break;
      const symbols = enumMap[def.enum_name]?.values.map(v => v.symbol) ?? [];
      // seqgen accepts the bare constant; allow a qualified one too (`Fw.Enabled.ENABLED`).
      const symbol = raw.split('.').pop() ?? raw;
      if (symbols.length && !symbols.includes(symbol)) {
        error(`'${raw}' is not a ${def.enum_name} constant: ${symbols.join(', ')}`);
      }
      break;
    }
    case 'repeat': {
      const members = def.repeat?.arguments ?? [];
      if (value.name === 'Array') {
        const elements = value.getChildren('Arg');
        const size = def.repeat?.min;
        if (members.length === 1 && size != null && elements.length !== size) {
          error(`'${def.name}' is an array of ${size}, got ${elements.length}`);
        }
        if (members.length === 1) {
          elements.forEach(e => out.push(...validateArgument(e, members[0], enumMap, text)));
        }
      } else if (value.name === 'Struct') {
        const given = new Map(
          value
            .getChildren('Member')
            .map(m => [text.slice(m.getChild('MemberName')!.from, m.getChild('MemberName')!.to), m]),
        );
        for (const member of members) {
          const node = given.get(member.name);
          const memberValue = node?.getChild('Arg');
          if (!memberValue) {
            error(`'${def.name}' is missing member '${member.name}'`);
          } else {
            out.push(...validateArgument(memberValue, member, enumMap, text));
          }
          given.delete(member.name);
        }
        for (const [name, node] of given) {
          out.push({ from: node.from, message: `Unknown member '${name}'`, severity: 'error', to: node.to });
        }
      } else {
        error(`'${def.name}' expects ${members.length === 1 ? 'an array [..]' : 'a struct {member: value, ..}'}`);
      }
      break;
    }
  }
  return out;
}

function parseInteger(raw: string): bigint | null {
  const cleaned = raw.replace(/_/g, '');
  if (!/^[+-]?(0[xX][0-9a-fA-F]+|\d+)$/.test(cleaned)) return null;
  const negative = cleaned.startsWith('-');
  const magnitude = BigInt(cleaned.replace(/^[+-]/, ''));
  return negative ? -magnitude : magnitude;
}

/** Default literal for an argument, in `.seq` syntax. */
export function fprimeSeqArgDefault(def: FswCommandArgument, enumMap: EnumMap): string {
  switch (def.arg_type) {
    case 'boolean':
      return 'false';
    case 'enum':
      return enumMap[def.enum_name]?.values[0]?.symbol ?? def.default_value ?? 'UNKNOWN';
    case 'float':
    case 'numeric':
      return '0.0';
    case 'var_string':
    case 'fixed_string':
      return '""';
    case 'repeat': {
      const members = def.repeat?.arguments ?? [];
      if (members.length === 1 && (def.repeat?.min ?? 0) > 1) {
        return `[${Array.from({ length: def.repeat?.min ?? 0 }, () => fprimeSeqArgDefault(members[0], enumMap)).join(', ')}]`;
      }
      return `{${members.map(m => `${m.name}: ${fprimeSeqArgDefault(m, enumMap)}`).join(', ')}}`;
    }
    default:
      return '0';
  }
}
