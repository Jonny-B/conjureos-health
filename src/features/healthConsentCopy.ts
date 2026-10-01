/**
 * The words on the consent-to-collect screen (components/HealthConsentGate).
 * Per-app: they must describe what THIS app collects and sends. A material
 * change here means bumping HEALTH_CONSENT_VERSION in healthConsent.ts.
 */

export const CONSENT_APP_NAME = "Conjure Health";

export const CONSENT_BODY: string[] = [
  "Conjure Health keeps a record of things about your body: what you eat, your weight, sleep, water, symptoms and exercise. Privacy laws such as Washington's My Health My Data Act call this consumer health data, and we ask for your agreement before we collect any.",
  "It is stored on your device and in your ConjureOS account. It is never sold, and never used for advertising.",
  "Some features send part of it to an AI to work: building a plan, and logging food from a description or a photo. Find patterns and the food coach ask for a separate agreement before they send anything. Other ConjureOS apps can read or add to it only when you allow them.",
];

export const CONSENT_CHECKBOX =
  "I agree that ConjureOS LLC may collect and store my health data in Conjure Health, and use it for these features, as the Consumer Health Data Privacy policy describes.";
