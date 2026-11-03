import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A "Minecraft" that is a real JVM program: it prints the lines the launcher looks for and behaves according to its
 * arguments, so launch, crash analysis and stopping can be tested with a real process.
 *
 *   crash-me → exit code 3          oom → prints an OutOfMemoryError and exits 1
 *   sleep    → keeps running until killed
 */
export async function buildFakeGameJar(workDir: string): Promise<Buffer> {
  const src = join(workDir, "fake-game-src");
  await mkdir(src, { recursive: true });
  await writeFile(
    join(src, "FakeMain.java"),
    `import java.util.Arrays;
public class FakeMain {
  public static void main(String[] a) throws Exception {
    System.out.println("Backend library: LWJGL version 3.3.3");
    System.out.println("ARGS=" + String.join("|", a));
    System.out.println("CP=" + System.getProperty("java.class.path"));
    System.out.println("中文测试");
    System.err.println("an error line");
    if (Arrays.asList(a).contains("oom")) {
      System.err.println("Exception in thread \\"main\\" java.lang.OutOfMemoryError: Java heap space");
      System.exit(1);
    }
    if (Arrays.asList(a).contains("crash-me")) System.exit(3);
    if (Arrays.asList(a).contains("sleep")) {
      for (int i = 0; i < 600; i++) { Thread.sleep(100); if (i % 10 == 0) System.out.println("tick " + i); }
    }
  }
}
`,
  );
  execFileSync("javac", ["-encoding", "UTF-8", "-d", src, join(src, "FakeMain.java")], { stdio: "pipe" });
  const jar = join(workDir, "fake-game.jar");
  execFileSync("jar", ["cf", jar, "-C", src, "FakeMain.class"], { stdio: "pipe" });
  return readFile(jar);
}
