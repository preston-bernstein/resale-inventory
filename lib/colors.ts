import { createVocabResolver } from '@/lib/vocabResolver';

const { resolveCanonical, validateInput, selectCanonical } = createVocabResolver('clothing_colors');

export const resolveCanonicalColor = resolveCanonical;
export const validateColorInput = validateInput;
export const selectCanonicalColor = selectCanonical;
