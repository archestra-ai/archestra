import { expect, goToPage, test } from '../fixtures';
import { expectChatReady, sendChatMessage } from '../utils/chat-ui';
import {
  getMockChatScenario,
  mockChatScenarios,
} from '../utils/chat-scenarios/scenarios';
import { installMockChatScenario } from '../utils/chat-scenarios/mock-chat';

test.describe.configure({ mode: 'serial' });

test.describe('chat mocked scenarios', () => {
  for (const scenario of mockChatScenarios) {
    test(`renders scenario: ${scenario.id}`, async ({ page }) => {
      await installMockChatScenario(page, scenario);
      await goToPage(page, scenario.route.initialPath);
      await expectChatReady(page);

      if (scenario.mode !== 'seeded') {
        const prompt =
          scenario.request?.assertLastUserMessageIncludes ??
          `run scenario ${scenario.id}`;
        await sendChatMessage(page, prompt);
      }

      for (const visibleText of scenario.assertions.visibleText) {
        await expect(
          page.getByText(visibleText, { exact: false }),
        ).toBeVisible();
      }

      if (scenario.assertions.visibleButtons) {
        for (const visibleButton of scenario.assertions.visibleButtons) {
          await expect(
            page.getByRole('button', { name: visibleButton, exact: true }),
          ).toBeVisible();
        }
      }

      if (scenario.assertions.visibleImages) {
        for (const visibleImage of scenario.assertions.visibleImages) {
          await expect(
            page.getByRole('img', { name: visibleImage, exact: true }),
          ).toBeVisible();
        }
      }

      if (scenario.assertions.hiddenText) {
        for (const hiddenText of scenario.assertions.hiddenText) {
          await expect(
            page.getByText(hiddenText, { exact: false }),
          ).toHaveCount(0);
        }
      }

      if (scenario.assertions.orderedText) {
        await expect
          .poll(async () => {
            const bodyText = await page.locator('body').innerText();
            const positions = scenario.assertions.orderedText?.map((entry) =>
              bodyText.indexOf(entry),
            );
            if (!Array.isArray(positions)) {
              return false;
            }
            return positions.every(
              (position, index) =>
                typeof position === 'number' &&
                position >= 0 &&
                (index === 0 || position > (positions[index - 1] as number)),
            );
          })
          .toBe(true);
      }
    });
  }

  test('streams progressive reasoning before the final answer arrives', async ({
    page,
  }) => {
    const scenario = getMockChatScenario('reasoning-and-text');
    await installMockChatScenario(page, scenario);

    await goToPage(page, scenario.route.initialPath);
    await expectChatReady(page);
    await sendChatMessage(page, 'show reasoning');

    await expect(
      page.getByText('Checking the deployment graph before answering.', {
        exact: false,
      }),
    ).toBeVisible();

    await expect(
      page.getByText(
        'The rollout is blocked by a missing database migration.',
        {
          exact: false,
        },
      ),
    ).not.toBeVisible({ timeout: 200 });

    await expect(
      page.getByText(
        'The rollout is blocked by a missing database migration.',
        {
          exact: false,
        },
      ),
    ).toBeVisible();
  });
});
