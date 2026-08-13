// Valid evaluator module with default export
export default function validEvaluator(latest, caze) {
  return {
    status: 'pass',
    reason: 'Test fixture always passes',
    latestMatch: latest,
    matchedCount: latest ? 1 : 0
  };
}
