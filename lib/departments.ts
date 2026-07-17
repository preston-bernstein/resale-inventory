import { createVocabResolver } from '@/lib/vocabResolver';

const { resolveCanonical, validateInput, selectCanonical } =
  createVocabResolver('clothing_departments');

export const resolveCanonicalDepartment = resolveCanonical;
export const validateDepartmentInput = validateInput;
export const selectCanonicalDepartment = selectCanonical;
