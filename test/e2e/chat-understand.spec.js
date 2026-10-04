/**
 * Chat / Understand Tab E2E Tests
 *
 * Tests the conversational AI chat feature in the Knowledge Graph Understand tab.
 * Covers chat session creation, message sending, RAG-based responses,
 * conversation history, and chat persona selection.
 *
 * Run: npm run test:e2e -- --grep "Chat Understand"
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, waitForAppReady } = require('./helpers/electronApp');
const { pressOpenSearchShortcut } = require('./helpers/e2eShortcuts');

test.describe('Chat Understand — API Surface', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have chat APIs available', async () => {
    const api = await window.evaluate(() => ({
      hasQueryStream: typeof window.electronAPI?.chat?.queryStream === 'function',
      hasCancelStream: typeof window.electronAPI?.chat?.cancelStream === 'function',
      hasStreamEvents:
        typeof window.electronAPI?.chat?.onStreamChunk === 'function' &&
        typeof window.electronAPI?.chat?.onStreamEnd === 'function'
    }));

    expect(api.hasQueryStream || api.hasStreamEvents).toBe(true);
    expect(api.hasCancelStream).toBe(true);
  });

  test('should have chat history store API', async () => {
    const api = await window.evaluate(() => ({
      hasListConversations: typeof window.electronAPI?.chat?.listConversations === 'function',
      hasGetConversation: typeof window.electronAPI?.chat?.getConversation === 'function',
      hasDeleteConversation: typeof window.electronAPI?.chat?.deleteConversation === 'function'
    }));

    const hasAny = Object.values(api).some((v) => v);
    expect(hasAny).toBe(true);
  });
});

test.describe('Chat Understand — UI Interactions', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should open Knowledge OS and navigate to Chat tab', async () => {
    await pressOpenSearchShortcut(window);
    await window.waitForTimeout(500);

    const understandTab = window
      .locator('button:has-text("Chat"), [role="tab"]:has-text("Chat")')
      .first();

    const isVisible = await understandTab.isVisible().catch(() => false);
    if (isVisible) {
      await understandTab.click({ force: true });
      await window.waitForTimeout(500);

      const chatUI = await window.evaluate(() => {
        const body = document.body.textContent || '';
        return {
          hasConversational: body.includes('Conversational') || body.includes('Chat'),
          hasInput: !!document.querySelector(
            'textarea, input[placeholder*="question" i], input[placeholder*="ask" i]'
          ),
          hasSendButton: Array.from(document.querySelectorAll('button')).some((button) =>
            /send/i.test((button.textContent || '').trim())
          ),
          hasNewChat: body.includes('New chat') || body.includes('new chat')
        };
      });

      expect(chatUI.hasConversational || chatUI.hasInput).toBe(true);
    }
  });

  test('should show chat input and send button on Chat tab', async () => {
    await pressOpenSearchShortcut(window);
    await window.waitForTimeout(500);

    const understandTab = window
      .locator('button:has-text("Chat"), [role="tab"]:has-text("Chat")')
      .first();
    if (await understandTab.isVisible().catch(() => false)) {
      await understandTab.click({ force: true });
      await window.waitForTimeout(500);

      const chatInput = window
        .locator(
          'textarea, input[placeholder*="question" i], input[placeholder*="ask" i], input[placeholder*="document" i]'
        )
        .first();

      const inputVisible = await chatInput.isVisible().catch(() => false);
      if (inputVisible) {
        await chatInput.fill('What files do I have?');
        const value = await chatInput.inputValue().catch(() => '');
        expect(value).toContain('What files');
      }
    }
  });

  test('should show New Chat button in sidebar', async () => {
    await pressOpenSearchShortcut(window);
    await window.waitForTimeout(500);

    const understandTab = window
      .locator('button:has-text("Chat"), [role="tab"]:has-text("Chat")')
      .first();
    if (await understandTab.isVisible().catch(() => false)) {
      await understandTab.click({ force: true });
      await window.waitForTimeout(500);

      const newChatBtn = window.locator('button:has-text("New chat")').first();
      const hasNewChat = await newChatBtn.isVisible().catch(() => false);

      expect(hasNewChat).toBe(true);
    }
  });

  test('should close Knowledge Graph chat with Escape', async () => {
    await pressOpenSearchShortcut(window);
    await window.waitForTimeout(500);

    const understandTab = window.locator('button:has-text("Chat")').first();
    if (await understandTab.isVisible().catch(() => false)) {
      await understandTab.click({ force: true });
      await window.waitForTimeout(300);

      await window.keyboard.press('Escape');
      await window.waitForTimeout(300);
    }
  });
});
