export function SimulationNote({ children }: { children: string }) {
  return (
    <p className="mgmt-simulation-note" role="note">
      <span aria-hidden="true">ⓘ</span> {children}
    </p>
  );
}
