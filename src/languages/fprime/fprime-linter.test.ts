import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { fprimeLinter } from './fprime-linter.js';
import { fprimeParser } from './fprime.js';
import { LRLanguage, LanguageSupport } from '@codemirror/language';

describe('F-Prime Linter', () => {
  function lint(doc: string) {
    // Create a simple language support with our parser
    const fprimeLanguage = LRLanguage.define({
      parser: fprimeParser,
    });

    const state = EditorState.create({
      doc,
      extensions: [new LanguageSupport(fprimeLanguage)],
    });

    const view = { state } as EditorView;
    return fprimeLinter(view);
  }

  describe('missing commas', () => {
    it('should flag missing comma between numbers', () => {
      const diagnostics = lint('R00:00:01.000 CMD 42 3.14\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('comma');
    });

    it('should flag missing comma between strings', () => {
      const diagnostics = lint('R00:00:01.000 CMD "str1" "str2"\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('comma');
    });

    it('should flag missing comma between identifiers', () => {
      const diagnostics = lint('R00:00:01.000 CMD INPUT_A INPUT_B\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('comma');
    });

    it('should flag missing comma between mixed types', () => {
      const diagnostics = lint('R00:00:01.000 CMD 42 "test"\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('comma');
    });
  });

  describe('valid syntax', () => {
    it('should not flag valid comma-separated arguments', () => {
      const diagnostics = lint('R00:00:01.000 CMD 42, 3.14, "test"\n');
      expect(diagnostics.length).toBe(0);
    });

    it('should not flag command without arguments', () => {
      const diagnostics = lint('R00:00:01.000 CMD_NO_OP\n');
      expect(diagnostics.length).toBe(0);
    });

    it('should not flag command with single argument', () => {
      const diagnostics = lint('R00:00:01.000 CMD 42\n');
      expect(diagnostics.length).toBe(0);
    });

    it('should not flag valid sequence with comments', () => {
      const doc = `; Comment
A2015-075T22:32:40.123 cmdDisp.CMD_NO_OP
R00:00:01.000 CMD 1, 2, 3
`;
      const diagnostics = lint(doc);
      expect(diagnostics.length).toBe(0);
    });
  });

  describe('extra tokens', () => {
    it('should flag unexpected tokens after command', () => {
      const diagnostics = lint('R00:00:01.000 CMD 42 unexpected\n');
      expect(diagnostics.length).toBeGreaterThan(0);
    });

    it('should flag invalid characters in arguments', () => {
      const diagnostics = lint('R00:00:01.000 CMD 42, @invalid\n');
      expect(diagnostics.length).toBeGreaterThan(0);
    });
  });

  describe('parse errors', () => {
    it('should provide helpful messages for missing commas', () => {
      const diagnostics = lint('R00:00:01.000 CMD 1 2 3\n');
      expect(diagnostics.length).toBeGreaterThan(0);

      // Should have helpful messages
      const hasCommaMessage = diagnostics.some(d => d.message.toLowerCase().includes('comma'));
      expect(hasCommaMessage).toBe(true);
    });

    it('should flag multiple errors in same line', () => {
      const diagnostics = lint('R00:00:01.000 CMD 1 2 3 4\n');
      // Should detect multiple missing commas
      expect(diagnostics.length).toBeGreaterThan(1);
    });
  });

  describe('empty and whitespace', () => {
    it('should not flag empty file', () => {
      const diagnostics = lint('');
      expect(diagnostics.length).toBe(0);
    });

    it('should not flag whitespace-only lines', () => {
      const diagnostics = lint('   \n\t\n  \n');
      expect(diagnostics.length).toBe(0);
    });

    it('should not flag comment-only lines', () => {
      const diagnostics = lint('; Just a comment\n; Another comment\n');
      expect(diagnostics.length).toBe(0);
    });
  });

  describe('time tag validation', () => {
    it('should not flag valid absolute time with day 001', () => {
      const diagnostics = lint('A2015-001T00:00:00.000 CMD\n');
      expect(diagnostics.length).toBe(0);
    });

    it('should not flag valid absolute time with day 075', () => {
      const diagnostics = lint('A2015-075T22:32:40.123 CMD\n');
      expect(diagnostics.length).toBe(0);
    });

    it('should not flag valid absolute time with day 366', () => {
      const diagnostics = lint('A2024-366T23:59:59.999 CMD\n');
      expect(diagnostics.length).toBe(0);
    });

    it('should flag invalid day of year 000', () => {
      const diagnostics = lint('A2015-000T00:00:00.000 CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('day of year');
    });

    it('should flag invalid day of year 367', () => {
      const diagnostics = lint('A2015-367T00:00:00.000 CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('day of year');
    });

    it('should not flag valid relative time', () => {
      const diagnostics = lint('R01:23:45.678 CMD\n');
      expect(diagnostics.length).toBe(0);
    });

    it('should flag relative time with hours >= 24', () => {
      const diagnostics = lint('R24:00:00.000 CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('hours');
    });

    it('should flag relative time with invalid minutes', () => {
      const diagnostics = lint('R00:60:00.000 CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('minutes');
    });

    it('should flag relative time with invalid seconds', () => {
      const diagnostics = lint('R00:00:60.000 CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('seconds');
    });
  });

  describe('command dictionary validation', () => {
    const mockCommandDictionary = {
      fswCommandMap: {
        'CMD_NO_OP': {
          stem: 'CMD_NO_OP',
          arguments: [],
        },
        'SET_VALUE': {
          stem: 'SET_VALUE',
          arguments: [
            { name: 'value', arg_type: 'integer' },
            { name: 'multiplier', arg_type: 'float' },
          ],
        },
      },
      hwCommandMap: {},
      fswCommands: [
        { stem: 'CMD_NO_OP' },
        { stem: 'SET_VALUE' },
      ],
      hwCommands: [],
      enumMap: {},
    };

    function lintWithDict(doc: string) {
      const fprimeLanguage = LRLanguage.define({
        parser: fprimeParser,
      });

      const state = EditorState.create({
        doc,
        extensions: [new LanguageSupport(fprimeLanguage)],
      });

      const view = { state } as EditorView;
      return fprimeLinter(view, mockCommandDictionary);
    }

    it('should not flag valid command in dictionary', () => {
      const diagnostics = lintWithDict('R00:00:01.000 CMD_NO_OP\n');
      expect(diagnostics.length).toBe(0);
    });

    it('should flag command not in dictionary', () => {
      const diagnostics = lintWithDict('R00:00:01.000 INVALID_CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('not found in command dictionary');
    });

    it('should provide suggestions for misspelled commands', () => {
      const diagnostics = lintWithDict('R00:00:01.000 CMD_NO_OPP\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].actions).toBeDefined();
      expect(diagnostics[0].actions?.length).toBeGreaterThan(0);
    });

    it('should flag too many arguments', () => {
      const diagnostics = lintWithDict('R00:00:01.000 CMD_NO_OP 42, 3.14, "extra"\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('Extra');
    });

    it('should flag too few arguments', () => {
      const diagnostics = lintWithDict('R00:00:01.000 SET_VALUE 42\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('Missing');
    });

    it('should not flag correct number of arguments', () => {
      const diagnostics = lintWithDict('R00:00:01.000 SET_VALUE 42, 3.14\n');
      expect(diagnostics.length).toBe(0);
    });

    it('should provide quick fix for removing extra arguments', () => {
      const diagnostics = lintWithDict('R00:00:01.000 CMD_NO_OP 42, 3.14\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].actions).toBeDefined();
      expect(diagnostics[0].actions?.length).toBeGreaterThan(0);
      expect(diagnostics[0].actions?.[0].name).toContain('Remove');
    });

    it('should not count comments as extra arguments', () => {
      const diagnostics = lintWithDict('R00:00:01.000 CMD_NO_OP; this is a comment\n');
      // Should have no errors - comment should not be counted as an argument
      expect(diagnostics.length).toBe(0);
    });
  });

  describe('malformed time tag detection', () => {
    it('should flag malformed absolute time with wrong day digits', () => {
      const diagnostics = lint('A2026-75T21:12:40.123 CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('Invalid absolute time format');
      expect(diagnostics[0].message).toContain('AYYYY-DDDTHH:MM:SS');
    });

    it('should flag malformed absolute time with slash separator', () => {
      const diagnostics = lint('A2026/075T21:12:40 CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('Invalid absolute time format');
    });

    it('should flag malformed relative time with wrong hour digits', () => {
      const diagnostics = lint('R1:00:00 CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('Invalid relative time format');
      expect(diagnostics[0].message).toContain('RHH:MM:SS');
    });

    it('should flag malformed relative time with three digit hours', () => {
      const diagnostics = lint('R100:00:00 CMD\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).toContain('Invalid relative time format');
    });

    it('should only show one error for malformed time tag (deduplication)', () => {
      const diagnostics = lint('A2026-75T21:12:40.123 CMD\n');
      // Should have one specific error, not multiple generic "Syntax error" messages
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0].message).not.toBe('Syntax error');
    });

    it('should not flag malformed time patterns in command arguments', () => {
      const diagnostics = lint('R00:00:01.000 CMD A2026-75\n');
      // Should flag as invalid command syntax or missing comma, not as malformed time tag
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics[0].message).not.toContain('Invalid absolute time format');
    });
  });

  describe('diagnostic deduplication', () => {
    it('should remove generic errors when specific errors exist on same line', () => {
      const diagnostics = lint('A2026-75T21:12:40 CMD\n');
      // Should only have the specific time format error, not generic syntax errors
      const syntaxErrors = diagnostics.filter(d => d.message === 'Syntax error');
      expect(syntaxErrors.length).toBe(0);
    });

    it('should keep generic errors when no specific errors exist', () => {
      const diagnostics = lint('@@@ invalid\n');
      expect(diagnostics.length).toBeGreaterThan(0);
      // All errors might be generic for completely invalid syntax
    });

    it('should deduplicate per line independently', () => {
      const doc = `A2026-75T21:12:40 CMD
R00:00:01.000 CMD 1 2
`;
      const diagnostics = lint(doc);
      // Line 1: should have time format error
      // Line 2: should have comma error
      const timeErrors = diagnostics.filter(d => d.message.includes('time format'));
      const commaErrors = diagnostics.filter(d => d.message.includes('comma'));
      expect(timeErrors.length).toBeGreaterThan(0);
      expect(commaErrors.length).toBeGreaterThan(0);
    });
  });
});
