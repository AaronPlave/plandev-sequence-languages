import type { FileStarter, PhoenixAdaptation } from '../../interfaces/adaptation.js';
import { fprimeRustLanguage, type FprimeRustLanguageOptions } from '../fprime-rust/language.js';
import { fprimeSeqLanguage } from './language.js';

/** A standard F Prime sequence (`fprime-seqgen` text). */
export const fprimeSeqStarter: FileStarter = {
  content: name =>
    `; ${name}: F Prime sequence, compiled to .bin with fprime-seqgen.\n` +
    '; One command per line: a time tag (R = relative, A = absolute), the command, its arguments.\n' +
    '; R00:00:00 Component.instance.COMMAND arg1 arg2\n',
  description: 'Timed commands, one per line (fprime-seqgen)',
  fileExtension: '.seq',
  label: 'F Prime sequence',
  namePlaceholder: 'startup',
};

/**
 * F Prime parcel: standard `.seq` sequences and Rust/WASM `.rs` sequences against the same
 * F Prime dictionary. Compiling to `.bin`/`.wasm` is done by Actions, not by the editor. A
 * deployment adds its Rust starters (which name its scaffolding Action) to `fileStarters`.
 */
export function getFprimeAdaptation(options: FprimeRustLanguageOptions = {}): PhoenixAdaptation {
  return {
    fileStarters: [fprimeSeqStarter],
    input: fprimeSeqLanguage,
    inputs: [fprimeRustLanguage(options)],
    outputs: [],
  };
}
