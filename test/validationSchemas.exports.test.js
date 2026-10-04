const { CUSTOM_PERSONA_ID_PREFIX } = require('../src/shared/chatPersonas');

describe('validationSchemas exports', () => {
  test('exports top-level settings and backup schemas in zod mode', () => {
    jest.resetModules();
    const validationSchemas = require('../src/main/ipc/validationSchemas');

    expect(validationSchemas.z).toBeTruthy();
    expect(validationSchemas.settingsSchema).toBeDefined();
    expect(validationSchemas.backupPathSchema).toBeDefined();
    expect(validationSchemas.settingsSchema).toBe(validationSchemas.schemas.settings);
    expect(validationSchemas.backupPathSchema).toBe(validationSchemas.schemas.backupPath);
  });

  test('settingsSchema accepts custom chat persona ids at the IPC gate', () => {
    const { settingsSchema } = require('../src/main/ipc/validationSchemas');
    const customId = `${CUSTOM_PERSONA_ID_PREFIX}legal-reviewer`;

    expect(
      settingsSchema.safeParse({
        chatPersona: customId,
        chatPersonaCustomGuidance: 'Always cite sources.',
        customChatPersonas: [{ id: 'legal-reviewer', label: 'Legal', guidance: 'Be precise.' }]
      }).success
    ).toBe(true);

    expect(settingsSchema.safeParse({ chatPersona: 'not-a-valid-persona' }).success).toBe(false);
    expect(settingsSchema.safeParse({ chatPersona: 'professional-researcher' }).success).toBe(true);
  });
});
