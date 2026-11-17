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
