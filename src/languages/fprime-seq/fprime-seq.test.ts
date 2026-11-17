import type { CommandDictionary } from '@nasa-jpl/plandev-ampcs';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { fprimeSeqParser } from './language.js';
import { fprimeSeqArgDefault, validateFprimeSeq } from './fprime-seq-validate.js';

// Parsed by the sequencing-server F Prime plugin from the Math deployment (F Prime v4.2.0).
const dictionary: CommandDictionary = JSON.parse(
  readFileSync(new URL('./math-command-dictionary.test.json', import.meta.url), 'utf8'),
);

const messages = (text: string) =>
  validateFprimeSeq(text, fprimeSeqParser.parse(text), dictionary).map(
    d => `${text.slice(d.from, d.to)} | ${d.message}`,
  );

describe('F Prime .seq validation', () => {
  it('accepts a sequence fprime-seqgen compiles', () => {
    expect(
      messages(`; comment
R00:00:00 CdhCore.cmdDisp.CMD_NO_OP
R00:00:01 CdhCore.cmdDisp.CMD_NO_OP_STRING "hello"
R00:00:01 MathProject.mathSender.DO_MATH 1.5, ADD, 2.0
A2026-321T12:00:00 CdhCore.health.HLTH_PING_ENABLE "blockDrv", ENABLED ; trailing
R00:00:05 MathProject.mathReceiver.FACTOR_PRM_SET 3.25
`),
    ).toEqual([]);
  });

  it('reports what fprime-seqgen reports, at the offending token', () => {
    expect(messages('R00:00:00 CdhCore.cmdDisp.CMD_NO_OPP')).toEqual([
      "CdhCore.cmdDisp.CMD_NO_OPP | Unknown command 'CdhCore.cmdDisp.CMD_NO_OPP'",
    ]);
    expect(messages('R00:00:01 MathProject.mathSender.DO_MATH 1.5, POW, 2.0')[0]).toMatch(
      /^POW \| 'POW' is not a MathProject.MathOp constant/,
    );
    expect(messages('R00:00:01 CdhCore.cmdDisp.CMD_TEST_CMD_1 1, 2.0, 300')).toEqual([
      "300 | 'arg3' 300 is out of range for U8 [0, 255]",
    ]);
    expect(messages('2026-321T12:00:00 CdhCore.cmdDisp.CMD_NO_OP')[0]).toMatch(/Syntax error/);
  });

  it('catches extra arguments, which fprime-seqgen silently drops', () => {
    expect(messages('R00:00:01 CdhCore.cmdDisp.CMD_NO_OP_STRING "a" "b"')).toEqual([
      '"b" | CdhCore.cmdDisp.CMD_NO_OP_STRING takes 1 argument(s) (arg1), got 2',
    ]);
  });

  it('keeps arguments on their own line', () => {
    expect(messages('R00:00:00 CdhCore.cmdDisp.CMD_NO_OP\nADD')[0]).toMatch(/Syntax error/);
  });

  it('checks types and time tags', () => {
    expect(messages('R00:00:00 CdhCore.cmdDisp.CMD_NO_OP_STRING 5')).toEqual(["5 | 'arg1' expects a quoted string"]);
    expect(messages('A2026-400T00:00:00 CdhCore.cmdDisp.CMD_NO_OP')).toEqual([
      'A2026-400T00:00:00 | Day of year 400 is out of range (001-366)',
    ]);
  });

  it('builds default arguments in .seq syntax', () => {
    const doMath = dictionary.fswCommandMap['MathProject.mathSender.DO_MATH'];
    expect(doMath.arguments.map(a => fprimeSeqArgDefault(a, dictionary.enumMap))).toEqual(['0.0', 'ADD', '0.0']);
  });
});
