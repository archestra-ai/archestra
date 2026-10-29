import { AppearanceSettings } from "./_parts/appearance-settings";

export default function AppearanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AppearanceSettings />
      {children}
    </>
  );
}
