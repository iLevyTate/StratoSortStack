const {
  validateSmokeThresholds,
  getJourneyMap
} = require('../scripts/stability/check-release-thresholds');

describe('check-release-thresholds', () => {
  test('getJourneyMap indexes journeys by id', () => {
    const result = getJourneyMap({
      journeys: [{ id: 'search', label: 'Search journey' }]
    });

    expect(result.get('search')).toEqual({ id: 'search', label: 'Search journey' });
  });

  test('fails when a required journey is missing from target report', () => {
    const errors = validateSmokeThresholds(
      {
        journeys: [{ id: 'search', label: 'Search journey', required: true, status: 'passed' }]
      },
      {
        journeys: []
      }
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Required journey missing from target: Search journey'),
        expect.stringContaining('Regression detected: Search journey missing from target report')
      ])
    );
  });

  test('fails when a previously passing journey regresses', () => {
    const errors = validateSmokeThresholds(
      {
        journeys: [{ id: 'search', label: 'Search journey', required: true, status: 'passed' }]
      },
      {
        journeys: [{ id: 'search', label: 'Search journey', required: true, status: 'failed' }]
      }
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Required journey failed in target: Search journey (failed)'),
        expect.stringContaining(
          'Regression detected: Search journey passed in baseline but not in target'
        )
      ])
    );
  });
});
