'use strict';

const {
  AI_ROUTED_OPERATIONS,
  AI_CLOUD_ROUTING_SCOPE_DETAIL,
  resolveOperationProviderId,
  describeOperationRouting,
  isCloudRoutingActive
} = require('../../src/shared/aiProviderRouting');

describe('aiProviderRouting', () => {
  test('scope detail mentions embeddings and images', () => {
    expect(AI_CLOUD_ROUTING_SCOPE_DETAIL).toMatch(/embeddings/i);
    expect(AI_CLOUD_ROUTING_SCOPE_DETAIL).toMatch(/image/i);
  });

  test('the routed operations are the three the router is asked to place', () => {
    expect(AI_ROUTED_OPERATIONS.map((op) => op.id)).toEqual(['analyze', 'chat', 'suggest']);
    for (const op of AI_ROUTED_OPERATIONS) {
      expect(op.label).toBeTruthy();
      expect(op.sends).toBeTruthy();
    }
  });

  const readyStatus = {
    providers: [
      { id: 'local', enabled: true, ready: true },
      { id: 'anthropic', enabled: true, ready: true },
      { id: 'openaiCompatible', enabled: true, ready: true }
    ]
  };

  describe('resolveOperationProviderId', () => {
    test('uses the per-operation entry, then the default, then local', () => {
      const settings = { routing: { default: 'anthropic', perOperation: { chat: 'local' } } };
      expect(resolveOperationProviderId(settings, 'chat')).toBe('local');
      expect(resolveOperationProviderId(settings, 'analyze')).toBe('anthropic');
      expect(resolveOperationProviderId({}, 'suggest')).toBe('local');
    });
  });

  describe('describeOperationRouting', () => {
    test('reports provider, override flag and readiness per operation', () => {
      const settings = {
        routing: { default: 'local', perOperation: { analyze: 'openaiCompatible' } }
      };
      const status = {
        providers: [
          { id: 'local', enabled: true, ready: true },
          { id: 'openaiCompatible', enabled: true, ready: false }
        ]
      };
      const rows = describeOperationRouting(settings, status);
      expect(rows.map((r) => [r.id, r.providerId, r.overridden, r.ready])).toEqual([
        ['analyze', 'openaiCompatible', true, false],
        ['chat', 'local', false, true],
        ['suggest', 'local', false, true]
      ]);
    });
  });

  describe('isCloudRoutingActive', () => {
    test('false when every operation is local', () => {
      expect(isCloudRoutingActive({ routing: { default: 'local' } }, readyStatus)).toBe(false);
    });

    test('true when the cloud default is enabled and ready', () => {
      expect(isCloudRoutingActive({ routing: { default: 'openaiCompatible' } }, readyStatus)).toBe(
        true
      );
    });

    test('true when only one operation is routed to a ready cloud provider', () => {
      expect(
        isCloudRoutingActive(
          { routing: { default: 'local', perOperation: { chat: 'anthropic' } } },
          readyStatus
        )
      ).toBe(true);
    });

    test('false when the cloud default is not ready (silent local fallback)', () => {
      expect(
        isCloudRoutingActive(
          { routing: { default: 'openaiCompatible' } },
          {
            providers: [
              { id: 'openaiCompatible', enabled: true, ready: false },
              { id: 'local', enabled: true, ready: true }
            ]
          }
        )
      ).toBe(false);
    });

    test('false when the cloud default is disabled', () => {
      expect(
        isCloudRoutingActive(
          { routing: { default: 'openaiCompatible' } },
          { providers: [{ id: 'openaiCompatible', enabled: false, ready: true }] }
        )
      ).toBe(false);
    });

    test('false when every operation that names a cloud provider is routed back to local', () => {
      expect(
        isCloudRoutingActive(
          {
            routing: {
              default: 'anthropic',
              perOperation: { analyze: 'local', chat: 'local', suggest: 'local' }
            }
          },
          readyStatus
        )
      ).toBe(false);
    });
  });
});
