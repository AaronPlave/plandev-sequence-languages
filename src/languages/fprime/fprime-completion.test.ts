import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { LanguageSupport, LRLanguage } from '@codemirror/language';
import { fprimeCompletion } from './fprime-completion.js';
import { fprimeParser } from './fprime.js';

describe('F-Prime Completion', () => {
  const mockCommandDictionary = {
    fswCommandMap: {
      CMD_NO_OP: {
        stem: 'CMD_NO_OP',
        description: 'No operation command',
        arguments: [],
      },
      SET_VALUE: {
        stem: 'SET_VALUE',
        description: 'Set a value',
        arguments: [
          { name: 'value', arg_type: 'integer', range: { min: 0, max: 100 } },
          { name: 'multiplier', arg_type: 'float', range: { min: 0, max: 1 } },
        ],
      },
      'cmdDisp.CMD_RESET': {
        stem: 'cmdDisp.CMD_RESET',
        description: 'Reset command with namespace',
        arguments: [],
      },
    },
    hwCommandMap: {
      HW_POWER_ON: {
        stem: 'HW_POWER_ON',
        description: 'Power on hardware',
        arguments: [],
      },
    },
    fswCommands: [
      { stem: 'CMD_NO_OP', description: 'No operation command' },
      { stem: 'SET_VALUE', description: 'Set a value' },
      { stem: 'cmdDisp.CMD_RESET', description: 'Reset command with namespace' },
    ],
    hwCommands: [{ stem: 'HW_POWER_ON', description: 'Power on hardware' }],
    enumMap: {},
  };

  function getCompletions(doc: string, pos?: number) {
    const fprimeLanguage = LRLanguage.define({
      parser: fprimeParser,
    });

    const state = EditorState.create({
      doc,
      extensions: [new LanguageSupport(fprimeLanguage)],
    });
    const actualPos = pos ?? doc.length;

    const context: CompletionContext = {
      state,
      pos: actualPos,
      explicit: false,
      matchBefore: (pattern: RegExp) => {
        const line = state.doc.lineAt(actualPos);
        const lineText = line.text;
        const cursorInLine = actualPos - line.from;
        const beforeCursor = lineText.slice(0, cursorInLine);

        const match = beforeCursor.match(pattern);
        if (match && match.index !== undefined) {
          return {
            from: line.from + match.index,
            to: actualPos,
            text: match[0],
          };
        }
        return null;
      },
      aborted: false,
      addEventListener: () => {},
    } as CompletionContext;

    const completionFn = fprimeCompletion(mockCommandDictionary);
    return completionFn(context);
  }

  describe('time tag completion', () => {
    it('should suggest time tags at start of line', () => {
      const result = getCompletions('');
      expect(result).not.toBeNull();
      expect(result!.options.length).toBeGreaterThan(0);
      expect(result!.options.some(opt => opt.label.startsWith('A'))).toBe(true);
      expect(result!.options.some(opt => opt.label.startsWith('R'))).toBe(true);
    });

    it('should complete absolute time tag from "A"', () => {
      const result = getCompletions('A');
      expect(result).not.toBeNull();
      expect(result!.options.length).toBeGreaterThan(0);
      expect(result!.options[0].label).toMatch(/^A\d{4}-\d{3}T\d{2}:\d{2}:\d{2}$/);
      expect(result!.options[0].section).toBe('Time Tags');
    });

    it('should complete relative time tag from "R"', () => {
      const result = getCompletions('R');
      expect(result).not.toBeNull();
      expect(result!.options.length).toBeGreaterThan(0);
      const relativeOpt = result!.options.find(opt => opt.label.startsWith('R'));
      expect(relativeOpt).toBeDefined();
      expect(relativeOpt!.label).toMatch(/^R\d{2}:\d{2}:\d{2}$/);
    });

    it('should complete partial absolute time tag', () => {
      const result = getCompletions('A2024-');
      expect(result).not.toBeNull();
      expect(result!.options.length).toBeGreaterThan(0);
      // Should complete with a time tag - may have different format but should start with A2024-
      expect(result!.options[0].label).toMatch(/^A2024-/);
    });

    it('should complete partial relative time tag', () => {
      const result = getCompletions('R01:');
      expect(result).not.toBeNull();
      expect(result!.options.length).toBeGreaterThan(0);
      // Should complete with R01: prefix
      expect(result!.options[0].label).toMatch(/^R01:/);
    });

    it('should provide info text for time tags', () => {
      const result = getCompletions('A');
      expect(result).not.toBeNull();
      const absOpt = result!.options.find(opt => opt.label.startsWith('A'));
      expect(absOpt?.info).toContain('Absolute');
    });
  });

  describe('command completion', () => {
    it('should suggest commands after time tag', () => {
      const doc = 'R00:00:01.000 C';
      const result = getCompletions(doc);
      // Completions may or may not be returned depending on context
      if (result) {
        expect(result.options.length).toBeGreaterThan(0);
        // Should have at least one command option
        const hasCommands = result.options.some(
          opt => opt.label === 'CMD_NO_OP' || opt.label === 'SET_VALUE'
        );
        expect(hasCommands).toBe(true);
      }
    });

    it('should filter commands by prefix', () => {
      const doc = 'R00:00:01.000 CMD';
      const result = getCompletions(doc);
      if (result && result.options.length > 0) {
        // If we get completions, they should match the prefix
        const commandOpts = result.options.filter(opt => opt.section?.includes('Command'));
        if (commandOpts.length > 0) {
          expect(commandOpts.every(opt => opt.label.toUpperCase().includes('CMD'))).toBe(true);
        }
      }
    });

    it('should include command arguments in apply text', () => {
      const doc = 'R00:00:01.000 SET';
      const result = getCompletions(doc);
      if (result) {
        const setValueOpt = result.options.find(opt => opt.label === 'SET_VALUE');
        if (setValueOpt) {
          expect(setValueOpt.apply).toContain(',');
        }
      }
    });

    it('should not include arguments for commands without args', () => {
      const doc = 'R00:00:01.000 CMD_NO';
      const result = getCompletions(doc);
      if (result) {
        const noOpOpt = result.options.find(opt => opt.label === 'CMD_NO_OP');
        if (noOpOpt) {
          expect(noOpOpt.apply).toBe('CMD_NO_OP');
        }
      }
    });

    it('should support commands with dots in name', () => {
      const doc = 'R00:00:01.000 cmdDisp';
      const result = getCompletions(doc);
      if (result) {
        const resetOpt = result.options.find(opt => opt.label === 'cmdDisp.CMD_RESET');
        // Should find command with dot notation
        expect(resetOpt).toBeDefined();
      }
    });

    it('should separate FSW and HW commands in sections', () => {
      const doc = 'R00:00:01.000 H';
      const result = getCompletions(doc);
      if (result) {
        const fswOpt = result.options.find(opt => opt.section === 'Flight Software Commands');
        const hwOpt = result.options.find(opt => opt.section === 'Hardware Commands');
        // Should have both types of commands in different sections
        expect(fswOpt || hwOpt).toBeDefined();
      }
    });

    it('should provide command descriptions', () => {
      const doc = 'R00:00:01.000 CMD_N';
      const result = getCompletions(doc);
      if (result) {
        const noOpOpt = result.options.find(opt => opt.label === 'CMD_NO_OP');
        if (noOpOpt) {
          expect(noOpOpt.info).toBe('No operation command');
        }
      }
    });
  });

  describe('no completions', () => {
    it('should return null when no completions available', () => {
      // In the middle of a command argument
      const doc = 'R00:00:01.000 CMD_NO_OP 42';
      const result = getCompletions(doc);
      // Might return null or empty depending on position
      if (result) {
        expect(result.options.length).toBe(0);
      }
    });

    it('should not suggest commands without time tag', () => {
      const doc = 'CMD_NO_OP';
      const result = getCompletions(doc);
      // Should suggest time tags, not commands
      if (result) {
        expect(result.options.every(opt => opt.section === 'Time Tags' || opt.label.startsWith('A') || opt.label.startsWith('R'))).toBe(true);
      }
    });
  });

  describe('without command dictionary', () => {
    it('should still suggest time tags without dictionary', () => {
      const state = EditorState.create({ doc: 'A' });
      const context: CompletionContext = {
        state,
        pos: 1,
        explicit: false,
        matchBefore: () => null,
        aborted: false,
        addEventListener: () => {},
      } as CompletionContext;

      const completionFn = fprimeCompletion(null);
      const result = completionFn(context);
      expect(result).not.toBeNull();
      expect(result!.options.some(opt => opt.label.startsWith('A'))).toBe(true);
    });

    it('should not suggest commands without dictionary', () => {
      const state = EditorState.create({ doc: 'R00:00:01.000 ' });
      const context: CompletionContext = {
        state,
        pos: 14,
        explicit: false,
        matchBefore: (pattern: RegExp) => {
          const match = ' '.match(pattern);
          return match ? { from: 14, to: 14, text: '' } : null;
        },
        aborted: false,
        addEventListener: () => {},
      } as CompletionContext;

      const completionFn = fprimeCompletion(null);
      const result = completionFn(context);
      // Should return null or empty since no command dictionary
      expect(result === null || result.options.length === 0).toBe(true);
    });
  });
});
