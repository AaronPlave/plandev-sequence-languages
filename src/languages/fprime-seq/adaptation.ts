import type { PhoenixAdaptation } from '../../interfaces/adaptation.js';
import { fprimeRustLanguage, type FprimeRustLanguageOptions } from '../fprime-rust/language.js';
import { fprimeSeqLanguage } from './language.js';

/**
 * F Prime parcel: standard `.seq` sequences and Rust/WASM `.rs` sequences against the same
 * F Prime dictionary. Compiling to `.bin`/`.wasm` is done by Actions, not by the editor.
 */
export function getFprimeAdaptation(options: FprimeRustLanguageOptions = {}): PhoenixAdaptation {
  return {
    input: fprimeSeqLanguage,
    inputs: [fprimeRustLanguage(options)],
    outputs: [],
  };
}
