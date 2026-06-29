export function ForbiddenPage() {
  return (
    <div className="flex h-screen w-full items-center justify-center text-center">
      <div className="inline-block">
        <h1 className="inline-block m-0 mr-5 pr-6 text-2xl font-medium align-top leading-[3rem] border-r border-black/30 dark:border-white/30">
          403
        </h1>
        <div className="inline-block h-12 leading-[3rem] align-middle">
          <h2 className="text-sm font-normal leading-[3rem] m-0">
            You don't have permission to access this page.
          </h2>
        </div>
      </div>
    </div>
  );
}
