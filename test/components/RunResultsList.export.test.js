/**
 * @jest-environment jsdom
 *
 * "Save list as CSV": one message for a saved list or a failure, none for a
 * cancelled dialog.
 */
import { renderHook, act } from '@testing-library/react';

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({ showSuccess: mockShowSuccess, showError: mockShowError })
}));

const mockExport = jest.fn();
jest.mock('../../src/renderer/services/ipc', () => ({
  filesIpc: { exportOrganizeReport: (...args) => mockExport(...args) }
}));

import { useRunResultsExport } from '../../src/renderer/components/organize/RunResultsList';

const rows = [
  { name: 'a.csv', originalPath: '/in/a.csv', finalPath: '/out/a.csv', outcome: 'moved' },
  { name: 'b.csv', originalPath: '/in/b.csv', finalPath: null, outcome: 'failed', reason: 'x' }
];

async function save() {
  const { result } = renderHook(() => useRunResultsExport(rows));
  await act(async () => {
    await result.current();
  });
}

describe('useRunResultsExport', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a saved list names the file', async () => {
    mockExport.mockResolvedValue({ success: true, filePath: 'C:\\Out\\results.csv', rowCount: 2 });
    await save();
    expect(mockExport).toHaveBeenCalledWith(rows);
    expect(mockShowSuccess).toHaveBeenCalledWith('Saved the list of 2 files to results.csv.');
    expect(mockShowError).not.toHaveBeenCalled();
  });

  test('a cancelled dialog says nothing', async () => {
    mockExport.mockResolvedValue({ success: false, canceled: true });
    await save();
    expect(mockShowSuccess).not.toHaveBeenCalled();
    expect(mockShowError).not.toHaveBeenCalled();
  });

  test('a failure says why', async () => {
    mockExport.mockResolvedValue({ success: false, error: 'EACCES: permission denied' });
    await save();
    expect(mockShowError).toHaveBeenCalledWith(
      'Could not save the list: EACCES: permission denied'
    );
  });

  test('a rejected call is reported too', async () => {
    mockExport.mockRejectedValue(new Error('IPC timeout'));
    await save();
    expect(mockShowError).toHaveBeenCalledWith('Could not save the list: IPC timeout');
  });
});
