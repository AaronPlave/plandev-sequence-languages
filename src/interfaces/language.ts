import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { CommandInfoMapper } from './command-info-mapper.js';
import type { LibrarySequenceSignature, PhoenixContext, PhoenixResources, UserSequence } from './phoenix.js';

/**
 * Base object properties for either input or output languages in Phoenix.
 */
export interface BaseLanguage {
  name: string;
  fileExtension: string;
  getEditorExtension?: (context: PhoenixContext, resources: PhoenixResources) => Extension[];
}

/**
 * Extension of base language implementation for "input" (authoring) language definition adds
 * `commandInfoMapper`, which feeds the Phoenix UI command panel, `format` to apply code
 * formatting, and `getLibrarySequences` to tell Phoenix how to evaluate a call signature(s) given
 * other sequence files in the workspace.
 */
export interface InputLanguage extends BaseLanguage {
  commandInfoMapper: CommandInfoMapper;
  format?: (view: EditorView, context: PhoenixContext) => void;
  /** Whether `format` can run in this editor now (e.g. its language server is ready). Default: yes. */
  canFormat?: (view: EditorView) => boolean;
  /** Editor commands the UI lists in a menu, so they are discoverable without their shortcuts. */
  editorCommands?: EditorCommand[];
  getLibrarySequences?: (sequence: UserSequence) => LibrarySequenceSignature[];
}

export interface EditorCommand {
  label: string;
  /** The key binding, for display (the language's own extensions bind it). */
  shortcut?: string;
  run: (view: EditorView) => boolean;
  isEnabled?: (view: EditorView) => boolean;
}

/**
 * Extension of base language implementation for "output" language definition adds converters that,
 * for each output language, convert to/from the specified input language.
 */
export interface OutputLanguage extends BaseLanguage {
  toOutputFormat: (input: string, context: PhoenixContext, name: string) => string;
  toInputFormat: (output: string, context: PhoenixContext, name: string) => string;
}
