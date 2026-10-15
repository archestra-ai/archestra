import { AppearanceSettings } from "./_components/appearance-settings";

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
