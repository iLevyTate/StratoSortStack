/**
 * @jest-environment jsdom
 *
 * A search result shows the date of its document. That date is stored as a
 * day ("2024-05-05"). The row parsed it with new Date(), which reads a
 * date-only string as UTC midnight, and formatted it in local time: the day
 * before, anywhere west of Greenwich.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import ResultRow from '../../src/renderer/components/search/ResultRow';
import { toLocalCalendarMs } from '../../src/shared/contentDateSanity';

// The real function, wrapped so a test can see the row use it.
jest.mock('../../src/shared/contentDateSanity', () => {
  const actual = jest.requireActual('../../src/shared/contentDateSanity');
  return { ...actual, toLocalCalendarMs: jest.fn(actual.toLocalCalendarMs) };
});

const noop = () => {};

function renderRow(metadata) {
  return render(
    <ResultRow
      result={{
        id: 'file:c:/docs/invoice.pdf',
        metadata: { path: 'C:\\Docs\\invoice.pdf', ...metadata }
      }}
      isSelected={false}
      isBulkSelected={false}
      isFocused={false}
      query=""
      onSelect={noop}
      onToggleBulk={noop}
      onOpen={noop}
      onReveal={noop}
      onCopyPath={noop}
    />
  );
}

describe('the date on a search result', () => {
  test('a document date is shown as the day it names', () => {
    renderRow({ documentDate: '2024-05-05' });

    expect(screen.getByText(new Date(2024, 4, 5).toLocaleDateString())).toBeInTheDocument();
  });

  // The test above cannot tell new Date('2024-05-05') from the day it
  // names where the zone is UTC, as on CI. This one can, in any zone: no
  // parse of the stored value gives the instant the helper is made to return.
  test('the day comes from the calendar-day helper, in every time zone', () => {
    const elsewhere = new Date(2031, 0, 15, 12);
    toLocalCalendarMs.mockReturnValueOnce(elsewhere.getTime());

    renderRow({ documentDate: '2024-05-05' });

    expect(toLocalCalendarMs).toHaveBeenCalledWith('2024-05-05');
    expect(screen.getByText(elsewhere.toLocaleDateString())).toBeInTheDocument();
  });

  test('the legacy date field is read the same way', () => {
    renderRow({ date: '2023-12-31' });

    expect(screen.getByText(new Date(2023, 11, 31).toLocaleDateString())).toBeInTheDocument();
  });

  test('a full timestamp is shown as its local day', () => {
    const at = new Date(2024, 4, 5, 23, 30);
    renderRow({ documentDate: at.toISOString() });

    expect(screen.getByText(at.toLocaleDateString())).toBeInTheDocument();
  });

  test('a value that is not a date shows no date', () => {
    renderRow({ documentDate: 'not a date', category: 'Finance' });

    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument();
  });
});
