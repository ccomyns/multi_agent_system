export function TopBar({ title }: { title: string }) {
  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
    </header>
  );
}
