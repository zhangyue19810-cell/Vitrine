import { MARK_LOOPS, PRODUCT } from "../brand";
import { escapeHtml } from "../html";
import { currentSpringForce, springElement, springNumber } from "./spring-ui";

/**
 * The opening animation: the two loops of the mark draw themselves and interlock, then the name is written in wet ink,
 * letter by letter, with a soft wash and a brush underline.
 * It is pure CSS (see styles/boot.css); this file only builds the markup, shows the real start-up step under it, and
 * lets the player skip. The splash never delays real work: it waits for the boot to finish, not the other way round.
 */

export interface Splash {
  /** Show what the launcher is doing right now and how far along it is (0–1). */
  status(text: string, progress: number): void;
  /** Resolves when the player asked to skip (click / key). */
  readonly skipped: Promise<void>;
  /** Fade out and remove. Resolves when the stage underneath is fully uncovered. */
  finish(): Promise<void>;
}

export function showSplash(root: HTMLElement, style: "full" | "short"): Splash {
  const letters = [...PRODUCT.name.toUpperCase()]
    .map((letter) => `<span>${escapeHtml(letter)}</span>`)
    .join("");
  const element = document.createElement("div");
  element.className = "splash";
  element.dataset.style = style;
  element.setAttribute("role", "status");
  element.setAttribute("aria-label", `${PRODUCT.name} 正在启动`);
  element.innerHTML = `
    <div class="splash-inner">
      <svg class="splash-mark" viewBox="28 72 200 112" aria-hidden="true">
        <path class="loop loop-a" pathLength="1" d="${MARK_LOOPS.left}"/>
        <path class="loop loop-b" pathLength="1" d="${MARK_LOOPS.right}"/>
        <circle class="core" cx="128" cy="128" r="5"/>
      </svg>
      <div class="splash-word"><b>${letters}</b><i>${escapeHtml(PRODUCT.nameCn)}</i></div>
      <div class="splash-status"><div class="splash-line"><i style="--p:.05"></i></div><div class="splash-text">STARTING</div></div>
    </div>
    <button class="splash-skip" type="button">点击或按任意键跳过</button>`;
  root.append(element);

  const bar = element.querySelector<HTMLElement>(".splash-line i")!;
  const label = element.querySelector<HTMLElement>(".splash-text")!;
  const mark = element.querySelector<HTMLElement>(".splash-mark")!;
  const loops = [...element.querySelectorAll<SVGPathElement>(".loop")];
  const core = element.querySelector<SVGCircleElement>(".core")!;
  const wordLetters = [...element.querySelectorAll<HTMLElement>(".splash-word b span")];
  const wordCn = element.querySelector<HTMLElement>(".splash-word i")!;
  const status = element.querySelector<HTMLElement>(".splash-status")!;
  const skipButton = element.querySelector<HTMLElement>(".splash-skip")!;
  const short = style === "short";
  const at = (normalMs: number) => short ? Math.round(normalMs * 0.32) : normalMs;
  const response = (normalSeconds: number) => short ? normalSeconds * 0.62 : normalSeconds;
  let resolveSkip!: () => void;
  const skipped = new Promise<void>((resolve) => (resolveSkip = resolve));
  const skip = () => resolveSkip();
  element.addEventListener("pointerdown", skip, { once: true });
  const onKey = () => skip();
  window.addEventListener("keydown", onKey, { once: true });

  const force = currentSpringForce();
  // The wash and brush underline are painted pseudo-elements; the spring
  // runner drives their custom properties rather than a CSS timeline.
  void springNumber({
    from: 0,
    to: 0.78,
    response: response(0.62),
    dampingRatio: 0.9,
    force,
    onUpdate: (value) => element.style.setProperty("--splash-wash", String(value)),
  });
  void springNumber({
    from: 0.8,
    to: 1.04,
    response: response(0.7),
    dampingRatio: 0.88,
    onUpdate: (value) => element.style.setProperty("--splash-wash-scale", String(value)),
  });
  void springNumber({
    from: 0,
    to: 0.72,
    response: response(0.52),
    dampingRatio: 0.88,
    delay: at(120),
    onUpdate: (value) => element.style.setProperty("--splash-droplets", String(value)),
  });
  void springNumber({
    from: 0.88,
    to: 1,
    response: response(0.6),
    dampingRatio: 0.9,
    delay: at(120),
    onUpdate: (value) => element.style.setProperty("--splash-droplets-scale", String(value)),
  });
  void springNumber({
    from: 0,
    to: 0.82,
    response: response(0.54),
    dampingRatio: 0.82,
    delay: at(300),
    onUpdate: (value) => element.style.setProperty("--splash-underline", String(value)),
  });
  void springNumber({
    from: 0,
    to: 1,
    response: response(0.56),
    dampingRatio: 0.78,
    delay: at(300),
    onUpdate: (value) => element.style.setProperty("--splash-underline-scale", String(value)),
  });
  void springNumber({
    from: 0,
    to: 1,
    response: response(0.52),
    dampingRatio: 0.8,
    delay: at(520),
    onUpdate: (value) => {
      element.style.setProperty("--splash-rule-opacity", String(Math.min(1, value)));
      element.style.setProperty("--splash-rule-scale", String(value));
    },
  });

  for (const [index, loop] of loops.entries()) {
    let progress = 0;
    void springNumber({
      from: 1,
      to: 0,
      response: response(0.82),
      dampingRatio: 0.86,
      force,
      delay: at(140 + index * 310),
      onUpdate: (value) => {
        progress = Math.max(0, Math.min(1, value));
        loop.style.strokeDashoffset = String(progress);
      },
    });
  }
  void springElement(core, {
    fromScale: 0.2,
    toScale: 1,
    fromOpacity: 0,
    toOpacity: 1,
    response: response(0.45),
    dampingRatio: 0.76,
    force,
    delay: at(1060),
  });
  void springElement(mark, {
    fromY: 12,
    toY: 0,
    fromScale: 0.9,
    toScale: 1,
    fromOpacity: 0,
    toOpacity: 1,
    response: response(0.64),
    dampingRatio: 0.86,
    force,
    transformOrigin: "50% 52%",
  });
  wordLetters.forEach((letter, index) => {
    void springElement(letter, {
      fromY: 18,
      toY: 0,
      fromX: 8,
      toX: 0,
      fromScale: 0.76,
      toScale: 1,
      fromOpacity: 0,
      toOpacity: 1,
      fromClip: 0,
      toClip: 160,
      clipOrigin: "0% 100%",
      transformOrigin: "0% 100%",
      response: response(0.42),
      dampingRatio: 0.78,
      force,
      delay: at(260 + index * 92),
    }).then(() => {
      letter.style.removeProperty("clip-path");
      letter.style.removeProperty("will-change");
    });
  });
  void springElement(wordCn, {
    fromY: 10,
    toY: 0,
    fromOpacity: 0,
    toOpacity: 1,
    response: response(0.48),
    dampingRatio: 0.88,
    delay: at(720),
  });
  void springElement(status, {
    fromY: 8,
    toY: 0,
    fromOpacity: 0,
    toOpacity: 1,
    response: response(0.46),
    dampingRatio: 0.9,
    delay: at(720),
  });
  void springElement(skipButton, {
    fromY: 8,
    toY: 0,
    fromOpacity: 0,
    toOpacity: 1,
    response: response(0.42),
    dampingRatio: 0.9,
    delay: at(1080),
  });

  let shownProgress = 0.05;
  let lineMotion = 0;
  element.style.setProperty("--p", String(shownProgress));

  return {
    skipped,
    status(text, progress) {
      label.textContent = text;
      const target = Math.max(0.04, Math.min(1, progress));
      const token = ++lineMotion;
      void springNumber({
        from: shownProgress,
        to: target,
        response: 0.34,
        dampingRatio: 0.88,
        force: currentSpringForce(),
        onUpdate: (value) => {
          if (token !== lineMotion) return;
          shownProgress = value;
          bar.style.setProperty("--p", String(value));
        },
      }).then(() => {
        if (token === lineMotion) bar.style.setProperty("--p", String(target));
      });
    },
    finish() {
      window.removeEventListener("keydown", onKey);
      return new Promise<void>((resolve) => {
        let done = false;
        const end = () => {
          if (done) return;
          done = true;
          element.remove();
          resolve();
        };
        element.dataset.leaving = "true";
        void springElement(element, {
          fromY: 0,
          toY: -18,
          fromScale: 1,
          toScale: 1.018,
          fromOpacity: 1,
          toOpacity: 0,
          response: 0.42,
          dampingRatio: 0.94,
          force: currentSpringForce(),
          retainFinal: true,
          transformOrigin: "100% 0%",
        }).then(end).catch(end);
      });
    },
  };
}
