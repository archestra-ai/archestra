import { $, browser } from '@wdio/globals';

describe('Archestra App Startup', () => {
  it('should launch the app and display the OnboardingWizard', async () => {
    // Wait for the app to fully load (increase timeout if needed)
    await browser.pause(3000);

    // Check if we can get the window title
    const title = await browser.getTitle();
    console.log('Application title:', title);

    // Wait for and check if the OnboardingWizard dialog is displayed
    // The OnboardingWizard renders inside a Dialog component
    const onboardingDialog = $('[role="dialog"]');
    await onboardingDialog.waitForExist({ timeout: 10000 });

    // Check if the welcome message is displayed
    const welcomeHeading = await $('h2*=Welcome to Archestra!');
    const isWelcomeVisible = await welcomeHeading.isDisplayed();
    expect(isWelcomeVisible).toBe(true);
  });
});
