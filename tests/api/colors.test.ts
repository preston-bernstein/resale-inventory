import { GET } from '@/app/api/colors/route';
import { STARTER_COLORS } from '@/lib/vocabSeed';
import { describeVocabListRoute } from './vocabRouteSuite';

describeVocabListRoute({
  route: 'colors',
  singular: 'color',
  table: 'clothing_colors',
  GET,
  starter: STARTER_COLORS,
});
