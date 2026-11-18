import { GET } from '@/app/api/departments/route';
import { STARTER_DEPARTMENTS } from '@/lib/vocabSeed';
import { describeVocabListRoute } from './vocabRouteSuite';

describeVocabListRoute({
  route: 'departments',
  singular: 'department',
  table: 'clothing_departments',
  GET,
  starter: STARTER_DEPARTMENTS,
});
