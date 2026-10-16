import Hud from "@/pages/hud";
import PunchPage from "@/pages/punch";

export default function App() {
  const path = window.location.pathname;
  if (path === "/punch" || path.startsWith("/punch/")) return <PunchPage />;
  return <Hud />;
}
