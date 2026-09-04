export function PageHeader({ title, description, actions }) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-balance">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground text-pretty">{description}</p>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
  );
}
