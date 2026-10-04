/**
 * Mirrors the merge in ModelSetupWizard applySelectedProfileConfig when
 * "Start in Advanced mode" is enabled: get current settings, then save with
 * experienceMode advanced (main process applyExperienceModeSettings restores
 * embedding defaults).
 */
const { EXPERIENCE_MODES } = require('../src/shared/experienceMode');

describe('ModelSetupWizard advanced settings merge (contract)', () => {
  test('merges experienceMode advanced without dropping unrelated keys', async () => {
    const get = jest.fn().mockResolvedValue({
      theme: 'light',
      notifications: true,
      experienceMode: 'simple'
    });
    const save = jest.fn().mockResolvedValue({ success: true });
    const current = await get();
    const merged = {
      ...(current && typeof current === 'object' ? current : {}),
      experienceMode: EXPERIENCE_MODES.ADVANCED
    };
    await save(merged);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        experienceMode: 'advanced',
        theme: 'light',
        notifications: true
      })
    );
  });
});
