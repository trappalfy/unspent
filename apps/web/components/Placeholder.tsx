/** Empty route placeholder for the scaffold stage. */
export function Placeholder({ title, stage }: { title: string; stage: number }) {
  return (
    <section className="mx-auto max-w-[1280px] px-4 py-16 md:px-8">
      <h1 className="text-xl">{title}</h1>
      <p className="mt-4 text-sm text-mute">$ built in stage {stage}</p>
    </section>
  );
}
