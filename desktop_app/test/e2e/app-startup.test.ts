import { $, browser } from '@wdio/globals';

describe('Archestra App Startup', () => {
  it('should launch the app and display the OnboardingWizard', async () => {
    // Wait for the app to fully load - increase timeout for slower platforms
    await browser.pause(5000);

    await $('[data-testid="onboarding-wizard-dialog"]').waitForExist({
      timeout: 30000,
      timeoutMsg: 'OnboardingWizard dialog did not appear within 30 seconds',
    });
  });
});
