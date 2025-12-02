interface EnterpriseLicenseRequiredProps {
  /** The name of the feature that requires the enterprise license */
  featureName: string;
}

/**
 * A reusable component that displays a message when an enterprise feature
 * requires the license to be activated.
 */
export function EnterpriseLicenseRequired({
  featureName,
}: EnterpriseLicenseRequiredProps) {
  return (
    <p className="text-muted-foreground mt-2">
      {featureName} is an enterprise feature that requires the enterprise
      license to be activated. Please reach out to{" "}
      <a
        href="mailto:sales@archestra.ai"
        className="text-primary hover:underline"
      >
        sales@archestra.ai
      </a>{" "}
      for more info.
    </p>
  );
}
