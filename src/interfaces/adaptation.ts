import type { InputLanguage, OutputLanguage } from './language.js';

/**
 * Adaptation implementations comply with this interface.
 */
export interface PhoenixAdaptation {
  input: InputLanguage;
  /**
   * Further authoring languages in the same parcel, sharing its dictionaries. The editor picks
   * the one whose `fileExtension` matches the file; `input` is the default.
   */
  inputs?: InputLanguage[];
  outputs: OutputLanguage[];
  /** Kinds of file the editor's New File dialog offers, besides a blank file. */
  fileStarters?: FileStarter[];
}

/** Arguments a starter's functions get: the typed name (no extension) and the chosen folder. */
export type FileStarterTarget = { destination: string; name: string };

/**
 * A kind of new file: either initial `content` written to `<folder>/<name><fileExtension>`, or a
 * SeqDev Action (`action`) that creates it, e.g. toolchain scaffolding.
 */
export interface FileStarter {
  label: string;
  description?: string;
  fileExtension: string;
  /** e.g. `my_sequence` */
  namePlaceholder?: string;
  /** An error message for an unusable name, or null. */
  validateName?: (name: string) => string | null;
  content?: (name: string) => string;
  action?: {
    /** The Action's name in the workspace. */
    name: string;
    /**
     * Where the file goes: workspace folders containing `containing` (e.g. `Cargo.toml`), shown as
     * `label`. With one such folder it is chosen automatically. Without any, `createIn` lets the
     * user pick a folder for the Action to set up a new one in (as subfolder `newFolder`, if
     * given); otherwise the starter is unavailable.
     */
    destination: { containing: string; createIn?: boolean; label: string; newFolder?: string };
    parameters: (target: FileStarterTarget) => Record<string, unknown>;
    /** The file to open once the Action succeeds, relative to the workspace. */
    createdFile: (target: FileStarterTarget) => string;
  };
}

/** The authoring language for a file name, or `null` if the file is not an input sequence. */
export function getInputLanguage(adaptation: PhoenixAdaptation, fileName: string): InputLanguage | null {
  const name = fileName.toLowerCase();
  return (
    [adaptation.input, ...(adaptation.inputs ?? [])].find(language =>
      name.endsWith((language.fileExtension.startsWith('.') ? '' : '.') + language.fileExtension.toLowerCase()),
    ) ?? null
  );
}
