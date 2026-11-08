import "@kitlangton/rolling-number/styles.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/home.css";
import "./styles/stage.css";
import "./styles/sheets.css";
import "./styles/boot.css";
import { startApp } from "./app/app";

startApp().catch((error: unknown) => {
  console.error("Vitrine failed to start", error);
  const message = error instanceof Error ? error.message : String(error);
  const stage = document.querySelector("#stage") ?? document.body;
  const card = document.createElement("div");
  card.className = "boot-card";
  card.innerHTML = '<div class="micro">STARTUP FAILED</div><h2>界面启动失败</h2><p></p><p><button class="btn accent" onclick="location.reload()">重新加载</button></p>';
  card.querySelector("p")!.textContent = message;
  stage.append(card);
});
