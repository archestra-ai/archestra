import { $ } from '@wdio/globals';

describe('Archestra App Startup', () => {
  it('should launch the app and display the OnboardingWizard', async () => {
    await $('[data-testid="onboarding-wizard-dialog"]').waitForExist({
      timeoutMsg: 'OnboardingWizard dialog did not appear within 30 seconds',
    });
  });
});
