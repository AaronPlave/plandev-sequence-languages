import { syntaxTree } from '@codemirror/language';
import type { Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { CommandDictionary } from '@nasa-jpl/plandev-ampcs';
import { distance } from 'fastest-levenshtein';
import { getChildrenNode, getFromAndTo } from '../../utils/tree-utils.js';
import { pluralize } from '../../utils/string.js';
import { FPRIME_NODES } from './fprime-grammar-constants.js';

/**
 * Linter for F-Prime sequences.
 * Flags parse errors and validates sequence structure.
 */
export function fprimeLinter(view: EditorView, commandDictionary?: CommandDictionary | null): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const tree = syntaxTree(view.state);

  if (!tree) {
    return diagnostics;
  }

  // Walk the tree and find error nodes
  tree.iterate({
    enter: node => {
      // Flag any parse errors (⚠ nodes)
      if (node.type.isError) {
        const text = view.state.sliceDoc(node.from, node.to);
        const errorDiagnostic = createErrorDiagnostic(node.node, text, view);
        if (errorDiagnostic) {
          diagnostics.push(errorDiagnostic);
        }
      }

      // Validate time tags
      if (node.name === FPRIME_NODES.TimeAbsolute || node.name === FPRIME_NODES.TimeRelative) {
        const timeDiagnostic = validateTimeTag(node.node, view);
        if (timeDiagnostic) {
          diagnostics.push(timeDiagnostic);
        }
      }

      // Validate commands against dictionary
      if (node.name === FPRIME_NODES.Command && commandDictionary) {
        const commandDiagnostics = validateCommandDictionary(node.node, view, commandDictionary);
        diagnostics.push(...commandDiagnostics);
      }
    },
  });

  // Deduplicate diagnostics per line - if a line has a specific error message,
  // remove generic "Syntax error" messages from that line to avoid hiding the details
  return deduplicateDiagnostics(diagnostics, view);
}

/**
 * Deduplicates diagnostics per line, removing generic errors when specific ones exist.
 */
function deduplicateDiagnostics(diagnostics: Diagnostic[], view: EditorView): Diagnostic[] {
  // Group diagnostics by line number
  const diagnosticsByLine = new Map<number, Diagnostic[]>();
  for (const diag of diagnostics) {
    const line = view.state.doc.lineAt(diag.from).number;
    if (!diagnosticsByLine.has(line)) {
      diagnosticsByLine.set(line, []);
    }
    diagnosticsByLine.get(line)!.push(diag);
  }

  // For each line, if there's a specific error message, remove generic "Syntax error" messages
  const filtered: Diagnostic[] = [];
  for (const diags of diagnosticsByLine.values()) {
    const hasSpecificError = diags.some(d => d.message !== 'Syntax error');
    if (hasSpecificError) {
      // Keep only non-generic errors
      filtered.push(...diags.filter(d => d.message !== 'Syntax error'));
    } else {
      // Keep all errors (they're all generic)
      filtered.push(...diags);
    }
  }

  return filtered;
}

/**
 * Creates a diagnostic for parse errors, attempting to provide helpful messages.
 */
function createErrorDiagnostic(node: SyntaxNode, text: string, view: EditorView): Diagnostic | null {
  // Get context around the error
  const parent = node.parent;
  const prevSibling = node.prevSibling;

  let message = 'Syntax error';
  const severity: 'error' | 'warning' = 'error';

  // Check if error looks like a malformed time tag
  // Time tags must be at the start of a line (after optional whitespace)
  const lineStart = view.state.doc.lineAt(node.from).from;
  const textBeforeError = view.state.sliceDoc(lineStart, node.from);

  // Only check for malformed time tags if there's only whitespace before the error
  if (text.trim() && !/\S/.test(textBeforeError)) {
    const trimmed = text.trim();

    // Check if line starts with something that looks like a malformed time tag
    if (/^A\d+/.test(trimmed)) {
      message = 'Invalid absolute time format. Expected: AYYYY-DDDTHH:MM:SS[.sss]';
    } else if (/^R\d+/.test(trimmed)) {
      message = 'Invalid relative time format. Expected: RHH:MM:SS[.sss]';
    }
  }

  // Try to provide more specific error messages based on context
  if (parent?.name === FPRIME_NODES.Args) {
    // Error in arguments - likely missing comma
    if (prevSibling) {
      const prevType = prevSibling.name;
      if (
        prevType === FPRIME_NODES.Number ||
        prevType === FPRIME_NODES.String ||
        prevType === FPRIME_NODES.Identifier
      ) {
        message = 'Missing comma between arguments';
      }
    }

    // Check if this looks like a valid argument type that's in the wrong place
    if (text.trim()) {
      const trimmed = text.trim();
      // Check if it's a number-like token
      if (/^\d+(\.\d+)?$/.test(trimmed) || /^0x[0-9a-f]+$/i.test(trimmed)) {
        message = 'Missing comma before this number argument';
      }
      // Check if it's an identifier-like token
      else if (/^[a-z_]\w*$/i.test(trimmed)) {
        message = 'Missing comma before this identifier';
      }
      // Check if it's a string-like token
      else if (trimmed.startsWith('"')) {
        message = 'Missing comma before this string argument';
      }
    }

    // For empty error nodes in Args context, still report as missing comma
    // (zero-width errors typically indicate missing separators)
    if (!text.trim() && prevSibling) {
      // Return diagnostic for zero-width error indicating missing comma
      return {
        from: node.from,
        to: node.from + 1, // Make it at least 1 character wide for visibility
        severity,
        message: 'Missing comma between arguments',
        source: 'fprime-linter',
      };
    }
  } else if (parent?.name === FPRIME_NODES.Command) {
    // Error at command level
    message = 'Invalid command syntax';
  }

  // If the error is just whitespace or empty (and not handled above), skip it
  if (!text.trim()) {
    return null;
  }

  return {
    from: node.from,
    to: node.to,
    severity,
    message,
    source: 'fprime-linter',
  };
}

/**
 * Validates F-Prime time format.
 */
function validateTimeTag(node: SyntaxNode, view: EditorView): Diagnostic | null {
  const text = view.state.sliceDoc(node.from, node.to).trim();

  if (node.name === FPRIME_NODES.TimeAbsolute) {
    // Format: AYYYY-DDDTHH:MM:SS[.sss]
    const absolutePattern = /^A\d{4}-\d{3}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
    if (!absolutePattern.test(text)) {
      return {
        from: node.from,
        to: node.to,
        severity: 'error',
        message: 'Invalid absolute time format. Expected: AYYYY-DDDTHH:MM:SS[.sss]',
        source: 'fprime-linter',
      };
    }

    // Validate day of year (001-366)
    // Extract DDD from AYYYY-DDDTHH:MM:SS (positions 6-8, after the dash at position 5)
    const dayOfYear = Number.parseInt(text.substring(6, 9), 10);
    if (dayOfYear < 1 || dayOfYear > 366) {
      return {
        from: node.from + 6,
        to: node.from + 9,
        severity: 'error',
        message: `Invalid day of year: ${dayOfYear}. Must be between 001 and 366`,
        source: 'fprime-linter',
      };
    }
  } else if (node.name === FPRIME_NODES.TimeRelative) {
    // Format: RHH:MM:SS[.sss]
    const relativePattern = /^R\d{2}:\d{2}:\d{2}(\.\d+)?$/;
    if (!relativePattern.test(text)) {
      return {
        from: node.from,
        to: node.to,
        severity: 'error',
        message: 'Invalid relative time format. Expected: RHH:MM:SS[.sss]',
        source: 'fprime-linter',
      };
    }

    // Validate hours are less than 24 (relative times limited to 24 hours)
    const hours = Number.parseInt(text.substring(1, 3), 10);
    if (hours >= 24) {
      return {
        from: node.from + 1,
        to: node.from + 3,
        severity: 'error',
        message: `Relative time hours must be less than 24, got: ${hours}`,
        source: 'fprime-linter',
      };
    }

    // Validate minutes and seconds
    const minutes = Number.parseInt(text.substring(4, 6), 10);
    const seconds = Number.parseInt(text.substring(7, 9), 10);
    if (minutes >= 60) {
      return {
        from: node.from + 4,
        to: node.from + 6,
        severity: 'error',
        message: `Invalid minutes: ${minutes}. Must be between 00 and 59`,
        source: 'fprime-linter',
      };
    }
    if (seconds >= 60) {
      return {
        from: node.from + 7,
        to: node.from + 9,
        severity: 'error',
        message: `Invalid seconds: ${seconds}. Must be between 00 and 59`,
        source: 'fprime-linter',
      };
    }
  }

  return null;
}

/**
 * Validates that command mnemonics exist in the command dictionary.
 * Returns diagnostic errors for commands not found in the dictionary.
 */
export function validateCommandDictionary(
  commandNode: SyntaxNode,
  view: EditorView,
  commandDictionary: CommandDictionary,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Get the command mnemonic node
  const mnemonicNode = commandNode.getChild(FPRIME_NODES.CommandMnemonic);
  if (!mnemonicNode) {
    return diagnostics;
  }

  // Extract the mnemonic text
  const mnemonicText = view.state.sliceDoc(mnemonicNode.from, mnemonicNode.to);

  // Check if the command exists in either FSW or hardware command maps
  const { fswCommandMap, hwCommandMap, fswCommands, hwCommands } = commandDictionary;
  const dictionaryCommand = fswCommandMap[mnemonicText] || hwCommandMap[mnemonicText];

  if (!dictionaryCommand) {
    // Command not found - generate suggestions using Levenshtein distance
    const allCommandStems = [...fswCommands.map(cmd => cmd.stem), ...hwCommands.map(cmd => cmd.stem)];

    const closestMatches = closestStrings(mnemonicText, allCommandStems, 3);

    diagnostics.push({
      from: mnemonicNode.from,
      to: mnemonicNode.to,
      severity: 'error',
      message: `Command '${mnemonicText}' not found in command dictionary`,
      source: 'fprime-linter',
      actions: closestMatches.map(suggestion => ({
        name: `Change to ${suggestion}`,
        apply(view, from, to) {
          view.dispatch({
            changes: { from, to, insert: suggestion },
          });
        },
      })),
    });
    return diagnostics;
  }

  // Validate argument count
  const argsNode = commandNode.getChild(FPRIME_NODES.Args);
  const expectedArgCount = dictionaryCommand.arguments?.length ?? 0;

  if (argsNode) {
    const argNodes = getChildrenNode(argsNode);
    const actualArgCount = argNodes.length;

    if (actualArgCount > expectedArgCount) {
      // Too many arguments
      const extraArgs = argNodes.slice(expectedArgCount);
      const { from, to } = getFromAndTo(extraArgs);
      const commandArgs = `argument${pluralize(extraArgs.length)}`;

      // Check if there's a comma before the first extra argument
      const firstExtraArg = extraArgs[0];
      let deleteFrom = from;
      if (firstExtraArg && expectedArgCount > 0) {
        // Look for comma between last valid arg and first extra arg
        const lastValidArg = argNodes[expectedArgCount - 1];
        if (lastValidArg) {
          const textBetween = view.state.sliceDoc(lastValidArg.to, firstExtraArg.from);
          const commaMatch = textBetween.match(/,/);
          if (commaMatch) {
            // Include the comma in the deletion range
            deleteFrom = lastValidArg.to + textBetween.indexOf(',');
          }
        }
      }

      diagnostics.push({
        from,
        to,
        severity: 'error',
        message: `Extra ${commandArgs}, definition has ${expectedArgCount}, but ${actualArgCount} ${pluralize(actualArgCount) ? 'are' : 'is'} present`,
        source: 'fprime-linter',
        actions: [
          {
            name: `Remove ${extraArgs.length} extra ${commandArgs}`,
            apply(view, argsFrom, argsTo) {
              view.dispatch({ changes: { from: deleteFrom, to: argsTo } });
            },
          },
        ],
      });
    } else if (actualArgCount < expectedArgCount) {
      // Too few arguments
      const commandArgs = `argument${pluralize(expectedArgCount - actualArgCount)}`;

      diagnostics.push({
        from: argsNode.from,
        to: argsNode.to,
        severity: 'error',
        message: `Missing ${commandArgs}, definition has ${expectedArgCount}, but ${actualArgCount} ${pluralize(actualArgCount) ? 'are' : 'is'} present`,
        source: 'fprime-linter',
      });
    } else {
      // Correct number of arguments - validate types and values
      for (let i = 0; i < argNodes.length; i++) {
        const argNode = argNodes[i];
        const argDef = dictionaryCommand.arguments?.[i];
        if (argDef) {
          const argDiagnostics = validateArgument(argNode, argDef, view, commandDictionary);
          diagnostics.push(...argDiagnostics);
        }
      }
    }
  } else if (expectedArgCount > 0) {
    // No arguments provided but command expects some
    const commandArgs = `argument${pluralize(expectedArgCount)}`;

    diagnostics.push({
      from: mnemonicNode.to,
      to: mnemonicNode.to,
      severity: 'error',
      message: `Missing ${commandArgs}, definition has ${expectedArgCount}, but 0 are present`,
      source: 'fprime-linter',
    });
  }

  return diagnostics;
}

/**
 * Validates an individual argument against its command dictionary definition.
 */
function validateArgument(
  argNode: SyntaxNode,
  argDef: { arg_type: string; name: string; range?: { min: number; max: number } | string[] | null; enum_name?: string },
  view: EditorView,
  commandDictionary: CommandDictionary,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const argText = view.state.sliceDoc(argNode.from, argNode.to);
  const argType = argNode.name;

  switch (argDef.arg_type) {
    case 'integer':
    case 'unsigned':
    case 'float':
    case 'numeric': {
      // Check if the argument is a number
      if (argType !== FPRIME_NODES.Number) {
        diagnostics.push({
          from: argNode.from,
          to: argNode.to,
          severity: 'error',
          message: `Incorrect type - expected number but got ${argType}`,
          source: 'fprime-linter',
        });
        break;
      }

      // Validate numeric range if specified (range is an object for numeric types, not a string array)
      if (argDef.range && !Array.isArray(argDef.range)) {
        const { min, max } = argDef.range;
        // Parse numeric value, handling hex (0x prefix)
        const numValue = argText.toLowerCase().startsWith('0x')
          ? Number.parseInt(argText, 16)
          : argDef.arg_type === 'float' || argDef.arg_type === 'numeric'
            ? Number.parseFloat(argText)
            : Number.parseInt(argText, 10);

        if (Number.isNaN(numValue)) {
          diagnostics.push({
            from: argNode.from,
            to: argNode.to,
            severity: 'error',
            message: `Invalid number format: ${argText}`,
            source: 'fprime-linter',
          });
        } else if (numValue < min || numValue > max) {
          const message =
            max !== min
              ? `Number out of range. Expected ${min} to ${max}, got ${numValue}`
              : `Number out of range. Expected ${min}`;

          diagnostics.push({
            from: argNode.from,
            to: argNode.to,
            severity: 'error',
            message,
            source: 'fprime-linter',
          });
        }
      }
      break;
    }

    case 'boolean': {
      // F-Prime booleans can be represented as strings "TRUE"/"FALSE" or identifiers
      if (argType === FPRIME_NODES.String) {
        const unquoted = argText.replace(/^"|"$/g, '');
        if (unquoted !== 'TRUE' && unquoted !== 'FALSE') {
          diagnostics.push({
            from: argNode.from,
            to: argNode.to,
            severity: 'error',
            message: `Invalid boolean value. Expected "TRUE" or "FALSE", got ${argText}`,
            source: 'fprime-linter',
          });
        }
      } else if (argType === FPRIME_NODES.Identifier) {
        if (argText !== 'TRUE' && argText !== 'FALSE') {
          diagnostics.push({
            from: argNode.from,
            to: argNode.to,
            severity: 'error',
            message: `Invalid boolean value. Expected TRUE or FALSE, got ${argText}`,
            source: 'fprime-linter',
          });
        }
      } else {
        diagnostics.push({
          from: argNode.from,
          to: argNode.to,
          severity: 'error',
          message: `Incorrect type - expected boolean but got ${argType}`,
          source: 'fprime-linter',
        });
      }
      break;
    }

    case 'enum': {
      // Enums can be identifiers or strings
      if (argType !== FPRIME_NODES.String && argType !== FPRIME_NODES.Identifier) {
        diagnostics.push({
          from: argNode.from,
          to: argNode.to,
          severity: 'error',
          message: `Incorrect type - expected enum (string or identifier) but got ${argType}`,
          source: 'fprime-linter',
        });
        break;
      }

      // Validate enum value - check enum_name in enumMap first, then fall back to range array
      let validSymbols: string[] | undefined;

      if (argDef.enum_name && commandDictionary.enumMap) {
        const enumDef = commandDictionary.enumMap[argDef.enum_name];
        if (enumDef) {
          validSymbols = enumDef.values.map(v => v.symbol);
        }
      }

      // Fall back to range array if enum_name didn't provide symbols
      if (!validSymbols && argDef.range && Array.isArray(argDef.range)) {
        validSymbols = argDef.range;
      }

      // If we have valid symbols, validate the argument value
      if (validSymbols && validSymbols.length > 0) {
        const argValue = argType === FPRIME_NODES.String ? argText.replace(/^"|"$/g, '') : argText;

        if (!validSymbols.includes(argValue)) {
          const closestMatch = closestStrings(argValue, validSymbols, 1)[0];
          diagnostics.push({
            from: argNode.from,
            to: argNode.to,
            severity: 'error',
            message: `Invalid enum value. Expected one of: ${validSymbols.join(', ')}`,
            source: 'fprime-linter',
            actions: closestMatch
              ? [
                  {
                    name: `Change to ${closestMatch}`,
                    apply(view, from, to) {
                      const replacement = argType === FPRIME_NODES.String ? `"${closestMatch}"` : closestMatch;
                      view.dispatch({
                        changes: { from, to, insert: replacement },
                      });
                    },
                  },
                ]
              : [],
          });
        }
      }
      break;
    }

    case 'fixed_string':
    case 'var_string': {
      // Strings must be quoted in F-Prime
      if (argType !== FPRIME_NODES.String) {
        diagnostics.push({
          from: argNode.from,
          to: argNode.to,
          severity: 'error',
          message: `Incorrect type - expected string but got ${argType}`,
          source: 'fprime-linter',
        });
      }
      break;
    }

    default:
      // Unknown argument type - skip validation
      break;
  }

  return diagnostics;
}

/**
 * Helper function to find the N closest strings using Levenshtein distance.
 */
function closestStrings(value: string, potentialMatches: string[], n: number): string[] {
  const distances = potentialMatches.map(s => ({ distance: distance(s, value), s }));
  distances.sort((a, b) => a.distance - b.distance);
  return distances.slice(0, n).map(pair => pair.s);
}
