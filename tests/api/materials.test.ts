import { GET } from '@/app/api/materials/route';
import { STARTER_MATERIALS } from '@/lib/vocabSeed';
import { describeVocabListRoute } from './vocabRouteSuite';

describeVocabListRoute({
  route: 'materials',
  singular: 'material',
  table: 'clothing_materials',
  GET,
  starter: STARTER_MATERIALS,
});
