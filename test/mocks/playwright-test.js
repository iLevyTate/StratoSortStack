/**
 * Jest-side mock for `@playwright/test`.
 *
 * `test/e2e/helpers/pageObjects.js` requires `@playwright/test` at module load
 * because it uses Playwright's `expect` for in-helper assertions like
 * `await expect(locator).toBeVisible(...)`. The unit test
 * `test/pageObjectsHelpers.test.js` exercises those helpers under Jest with
 * locators built from `jest.fn()`, but the real `@playwright/test` package
 * isn't designed to load outside the Playwright runtime — its module-init
 * code references browser/server primitives that throw under Node's plain
 * test runner.
 *
 * We don't need real assertion semantics here because the unit test only
 * cares about which locator methods get called (it asserts on the jest mocks
 * directly). So this mock returns a permissive `expect` that resolves any
 * matcher to a no-op promise, plus the minimal `_electron`/`test` surface
 * other helpers reference.
 */

function noopAsync() {
  return Promise.resolve();
}

function buildMatcherSurface() {
  const handler = {
    get(target, prop) {
      if (prop === 'not') return buildMatcherSurface();
      if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
      return noopAsync;
    }
  };
  return new Proxy({}, handler);
}

function expectImpl() {
  return buildMatcherSurface();
}

expectImpl.configure = () => expectImpl;
expectImpl.poll = () => buildMatcherSurface();
expectImpl.soft = expectImpl;
expectImpl.extend = () => {};

const noopTest = () => {};
noopTest.beforeAll = () => {};
noopTest.beforeEach = () => {};
noopTest.afterAll = () => {};
noopTest.afterEach = () => {};
noopTest.describe = () => {};
noopTest.skip = () => {};
noopTest.only = () => {};
noopTest.use = () => {};

module.exports = {
  expect: expectImpl,
  test: noopTest,
  _electron: {
    launch: noopAsync
  }
};
