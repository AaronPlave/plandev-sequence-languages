import type { StateEffectType } from '@codemirror/state';
import type { indentService, LRLanguage } from '@codemirror/language';
import type { linter } from '@codemirror/lint';
import type { EditorView, hoverTooltip, Tooltip, ViewPlugin } from '@codemirror/view';
import type { ChannelDictionary, CommandDictionary, ParameterDictionary } from '@nasa-jpl/plandev-ampcs';
import type { VariableDeclaration } from '@nasa-jpl/seq-json-schema/types';

export type UserSequence = {
  definition: string;
  name: string;
};

export type LibrarySequenceSignature = {
  name: string;
  parameters: VariableDeclaration[];
};

/**
 * Static resources for adaptations to abstract interactions with UI/Phoenix core capabilities.
 */
export type CreateTooltip = (text: string[], from: number, to?: number) => Tooltip;

/** Language intelligence (e.g. a language server) as the editor shows it to the user. */
export type CodeHelpStatus = { state: 'preparing' | 'ready' | 'unavailable'; message?: string };

export interface PhoenixResources {
  createTooltip: CreateTooltip;
  indentService: typeof indentService;
  linter: typeof linter;
  hoverTooltip: typeof hoverTooltip;
  EditorView: typeof EditorView;
  LRLanguage: typeof LRLanguage;
  ViewPlugin: typeof ViewPlugin;
  /** Optional: report `CodeHelpStatus` to the editor UI with `view.dispatch({ effects: setCodeHelpStatus.of(status) })`. */
  setCodeHelpStatus?: StateEffectType<CodeHelpStatus>;
}

/**
 * Dynamic Phoenix context used by adaptation components. Dictionaries are available if included in
 * the current parcel.
 *
 * TODO consider whether we can abstract all knowledge of library sequences out of the UI
 * That would mean we could have library sequences accessible via PhoenixContext and let
 * the adaptation decide what to do. Right now, if we want dictionaries accessible to
 * `getLibrarySequences`, we create a circular dependency since the context contains the
 * library sequences.
 */
export interface PhoenixContext {
  commandDictionary: CommandDictionary | null;
  channelDictionary: ChannelDictionary | null;
  parameterDictionaries: ParameterDictionary[];
  librarySequences: LibrarySequenceSignature[];
  /**
   * The workspace file being edited, when there is one. Lets a language address the document
   * outside the editor, e.g. as a language server document URI.
   */
  sequenceFile?: { path: string; workspaceId: number };
  /**
   * Optional: show another file of the workspace in the editor (e.g. for Go to Definition) through
   * the UI's usual navigation, with its unsaved-changes prompt and permissions. Resolves to the
   * editor once it holds the file, or null if the user stayed or the file cannot be opened.
   */
  openWorkspaceFile?: (path: string) => Promise<EditorView | null>;
}
