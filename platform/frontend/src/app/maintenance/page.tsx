const DEFAULT_MAINTENANCE_MESSAGE =
  "Archestra is temporarily unavailable while maintenance is in progress.";

export default function MaintenancePage() {
  const message =
    process.env.ARCHESTRA_MAINTENANCE_MODE_MESSAGE?.trim() ||
    DEFAULT_MAINTENANCE_MESSAGE;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-xl space-y-6 text-center">
        <div className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground">
            Maintenance mode
          </p>
          <h1 className="text-3xl font-semibold tracking-normal sm:text-4xl">
            We&apos;ll be back shortly
          </h1>
        </div>
        <p className="text-base leading-7 text-muted-foreground">{message}</p>
      </section>
    </main>
  );
}
