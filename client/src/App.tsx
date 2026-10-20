import Hud from "@/pages/hud";
import PresencePage from "@/pages/presence";

export default function App() {
  const path = window.location.pathname;
  if (path === "/presence" || path.startsWith("/presence/")) return <PresencePage />;
  return <Hud />;
}
