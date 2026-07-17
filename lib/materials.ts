import { createVocabResolver } from '@/lib/vocabResolver';

const { resolveCanonical, validateInput, selectCanonical } =
  createVocabResolver('clothing_materials');

export const resolveCanonicalMaterial = resolveCanonical;
export const validateMaterialInput = validateInput;
export const selectCanonicalMaterial = selectCanonical;
